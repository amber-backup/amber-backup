import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Db, KYSELY } from '../database/database.module';
import {
  BackupJobRow,
  CheckInfo,
  IntegrityCheckConfig,
  IntegrityLevel,
  RepositoryUpdate,
  RunTrigger,
} from '../database/database.types';
import { ResticService } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JobsService } from './jobs.service';

/** Keeps a check log from growing without bound (mirrors the other runners). */
const MAX_LOG_LINES = 1000;

/** Parts a rotating check splits the data into unless the schedule says otherwise. */
export const DEFAULT_SUBSET_PARTS = 12;

/** First agent release that announces the `check` capability. */
export const CHECK_MIN_AGENT_VERSION = '1.26.0';

/** Run error recorded when restic reports damage (details are in the log). */
export const DAMAGED_MESSAGE =
  'Integrity errors found — the log lists the damaged data and how to repair it';

/** Final outcome of a check, whether it ran here or on an agent. */
export interface CheckOutcome {
  status: 'success' | 'failed' | 'cancelled';
  damaged: boolean;
  error?: string | null;
  log?: string | null;
}

/**
 * Runs `restic check` as an activity of its own: a `job_runs` row of kind
 * 'check'. Local jobs are checked by this process; agent jobs are queued for
 * their agent (claimed in AgentsService, reported back via `recordAgentResult`),
 * because the agent is the host that reaches the repository for backups.
 *
 * The verdict is stored on the repository (see migration 019) and a rotating
 * check advances to its next part only once the current one has passed, so a
 * damaged or unfinished part is read again next time.
 */
@Injectable()
export class CheckRunnerService implements OnApplicationShutdown {
  private readonly logger = new Logger(CheckRunnerService.name);

  /** Checks currently executing in this process, keyed by their run id. */
  private readonly running = new Map<string, AbortController>();

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly restic: ResticService,
    private readonly targets: TargetsService,
    private readonly notifications: NotificationsService,
    private readonly jobs: JobsService,
  ) {}

  /** Abort in-flight checks on shutdown so restic children don't block exit. */
  onApplicationShutdown(): void {
    for (const ctrl of this.running.values()) ctrl.abort();
  }

  /**
   * Aborts a check this process is running. Returns false when the run is
   * unknown here (already finished, or executed by an agent).
   */
  cancel(runId: string): boolean {
    const ctrl = this.running.get(runId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  /**
   * Starts an integrity check of a job's repository and resolves with the run
   * id at once. `level` defaults to the job's scheduled level. Refuses with a
   * 409 while another activity uses the repository: restic checks take an
   * exclusive lock, so running one next to a backup, prune or restore would
   * fail one of them.
   */
  async start(
    jobId: string,
    trigger: RunTrigger,
    level?: IntegrityLevel,
  ): Promise<string> {
    const job = await this.jobs.getRow(jobId);
    const local = job.location === 'local';
    if (!local) await this.assertAgentCanCheck(job);
    await this.assertIdle(jobId);

    const info = planCheck(job, level);
    const row = await this.db
      .insertInto('job_runs')
      .values({
        job_id: jobId,
        kind: 'check',
        trigger,
        // Agent jobs wait for their agent's next poll.
        status: local ? 'running' : 'queued',
        started_at: local ? new Date() : null,
        check_info: JSON.stringify(info),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    if (local) void this.execute(row.id, job, info);
    return row.id;
  }

  /** Records the outcome an agent reported for a check it was handed. */
  async recordAgentResult(
    agentId: string,
    runId: string,
    outcome: CheckOutcome,
  ): Promise<void> {
    const run = await this.db
      .selectFrom('job_runs')
      .innerJoin('backup_jobs', 'backup_jobs.id', 'job_runs.job_id')
      .select([
        'job_runs.check_info as check_info',
        'backup_jobs.repository_id as repository_id',
      ])
      .where('job_runs.id', '=', runId)
      .where('job_runs.agent_id', '=', agentId)
      .where('job_runs.kind', '=', 'check')
      .executeTakeFirst();
    if (!run) return;
    const info = parseInfo(run.check_info);
    await this.settle(runId, info, run.repository_id, outcome);
  }

  /**
   * Agents older than CHECK_MIN_AGENT_VERSION don't announce the `check`
   * capability and are never handed the task, so the run would only sit in
   * the queue until it times out. Refuse up front and name the fix instead.
   */
  private async assertAgentCanCheck(job: BackupJobRow): Promise<void> {
    if (!job.agent_id) return;
    const agent = await this.db
      .selectFrom('agents')
      .select(['name', 'agent_version'])
      .where('id', '=', job.agent_id)
      .executeTakeFirst();
    if (agent?.agent_version && versionLess(agent.agent_version, CHECK_MIN_AGENT_VERSION)) {
      throw new ConflictException(
        `Agent ${agent.name} runs version ${agent.agent_version}, which cannot run integrity checks — update it to ${CHECK_MIN_AGENT_VERSION} or newer`,
      );
    }
  }

  private async assertIdle(jobId: string): Promise<void> {
    const active = await this.db
      .selectFrom('job_runs')
      .select(['kind', 'status'])
      .where('job_id', '=', jobId)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
    if (active) {
      throw new ConflictException(
        `A ${active.kind} of this job is ${active.status} — start the check once it has finished`,
      );
    }
    const restore = await this.db
      .selectFrom('restore_runs')
      .select('id')
      .where('job_id', '=', jobId)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
    if (restore) {
      throw new ConflictException(
        'A restore from this repository is in progress — start the check once it has finished',
      );
    }
  }

  private async execute(
    runId: string,
    job: BackupJobRow,
    info: CheckInfo,
  ): Promise<void> {
    const logLines: string[] = [];
    const onLog = (line: string) => {
      logLines.push(line);
      if (logLines.length > MAX_LOG_LINES) logLines.shift();
    };
    const abort = new AbortController();
    this.running.set(runId, abort);
    try {
      const ctx = await this.targets.resolveForJob(job);
      const { damaged } = await this.restic.check(ctx, info, {
        onLog,
        signal: abort.signal,
      });
      await this.settle(runId, info, job.repository_id, {
        status: damaged ? 'failed' : 'success',
        damaged,
        error: damaged ? DAMAGED_MESSAGE : null,
        log: logLines.join('\n'),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = abort.signal.aborted;
      this.logger.warn(`Check ${runId} ${aborted ? 'cancelled' : 'failed'}: ${message}`);
      await this.settle(runId, info, job.repository_id, {
        status: aborted ? 'cancelled' : 'failed',
        damaged: false,
        error: message,
        log: logLines.join('\n'),
      }).catch((e) => this.logger.error(`Could not record check ${runId}: ${e}`));
    } finally {
      this.running.delete(runId);
    }
  }

  /**
   * Finishes the run row, then carries the verdict over to the repository and
   * notifies. A run that is no longer `running` (cancelled meanwhile) keeps its
   * state and changes nothing else.
   */
  private async settle(
    runId: string,
    info: CheckInfo,
    repositoryId: string,
    outcome: CheckOutcome,
  ): Promise<void> {
    const updated = await this.db
      .updateTable('job_runs')
      .set({
        status: outcome.status,
        finished_at: new Date(),
        error: outcome.error ?? null,
        log: outcome.log ?? null,
        check_info: JSON.stringify({ ...info, damaged: outcome.damaged }),
      })
      .where('id', '=', runId)
      .where('status', '=', 'running')
      .executeTakeFirst();
    if (Number(updated?.numUpdatedRows ?? 0) === 0) return;
    if (outcome.status === 'cancelled') return;

    await this.db
      .updateTable('repositories')
      .set(repositoryPatch(info, outcome))
      .where('id', '=', repositoryId)
      .execute();

    void this.notifications
      .notifyJobRun(runId)
      .catch((e) => this.logger.warn(`Notify failed for check ${runId}: ${e}`));
  }
}

function parseInfo(value: unknown): CheckInfo {
  const parsed =
    typeof value === 'string' ? (JSON.parse(value) as CheckInfo) : (value as CheckInfo | null);
  return parsed ?? { level: 'quick' };
}

/** Compares `major.minor.patch` versions (a leading `v` is ignored). */
export function versionLess(a: string, b: string): boolean {
  const parse = (s: string) =>
    s.trim().replace(/^v/, '').split('.').slice(0, 3).map((p) => parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

export function parseIntegrityConfig(value: unknown): IntegrityCheckConfig {
  return typeof value === 'string'
    ? (JSON.parse(value) as IntegrityCheckConfig)
    : ((value as IntegrityCheckConfig | null) ?? {});
}

/**
 * What the next check of a job verifies. A rotating check continues where the
 * last passed part left off, and restarts at part 1 when the number of parts
 * has changed since (the old position means nothing for the new split).
 */
export function planCheck(
  job: Pick<
    BackupJobRow,
    'integrity_check' | 'repo_check_subset_next' | 'repo_check_subset_parts'
  >,
  level?: IntegrityLevel,
): CheckInfo {
  const config = parseIntegrityConfig(job.integrity_check);
  const chosen = level ?? config.level ?? 'quick';
  if (chosen !== 'rotating') return { level: chosen };
  const parts = config.subsetParts ?? DEFAULT_SUBSET_PARTS;
  const next = job.repo_check_subset_next ?? 1;
  const part =
    job.repo_check_subset_parts === parts && next >= 1 && next <= parts ? next : 1;
  return { level: 'rotating', part, parts };
}

/** Repository columns to write for a finished check (see migration 019). */
export function repositoryPatch(
  info: CheckInfo,
  outcome: CheckOutcome,
): RepositoryUpdate {
  const now = new Date();
  if (outcome.damaged) {
    return {
      check_status: 'damaged',
      check_at: now,
      check_level: info.level,
      check_error: null,
    };
  }
  if (outcome.status !== 'success') {
    return { check_error: outcome.error ?? 'Check failed' };
  }
  const patch: RepositoryUpdate = {
    check_status: 'passed',
    check_at: now,
    check_level: info.level,
    check_error: null,
  };
  if (info.level === 'full') patch.data_verified_at = now;
  if (info.level === 'rotating' && info.part && info.parts) {
    patch.check_subset_parts = info.parts;
    patch.check_subset_next = (info.part % info.parts) + 1;
    // Parts only advance on success, so passing the last one completes a
    // rotation in which every part was read back.
    if (info.part === info.parts) patch.data_verified_at = now;
  }
  return patch;
}
