import { Inject, Injectable, Logger } from '@nestjs/common';
import { Db, KYSELY } from '../database/database.module';
import { RunTrigger } from '../database/database.types';
import { ResticService } from '../restic/restic.service';
import { ResticContext } from '../restic/restic.types';
import { RepositoriesService } from '../repositories/repositories.service';

/** Keeps a prune log from growing without bound (mirrors the backup runner). */
const MAX_LOG_LINES = 1000;

export interface PruneRunOptions {
  jobId: string;
  /** Repository whose cached size is refreshed once the prune succeeds. */
  repositoryId: string;
  trigger: RunTrigger;
  /** Backup run whose retention asked for this prune; null for a manual one. */
  parentRunId?: string | null;
  ctx: ResticContext;
}

/** Outcome of a prune executed elsewhere (by an agent), to be recorded here. */
export interface PruneOutcome {
  jobId: string;
  repositoryId: string;
  trigger: RunTrigger;
  parentRunId: string | null;
  agentId: string;
  status: 'success' | 'failed';
  startedAt: Date;
  finishedAt: Date;
  error?: string | null;
  log?: string | null;
  /** The agent already reported the repository's figures after the prune. */
  statsReported?: boolean;
}

/**
 * Runs `restic prune` as an activity of its own: a `job_runs` row of kind
 * 'prune' with its own start/end, status and log, so a slow prune shows up in
 * the activity feed instead of stretching the backup it belongs to.
 */
@Injectable()
export class PruneRunnerService {
  private readonly logger = new Logger(PruneRunnerService.name);

  /** Prunes currently executing in this process, keyed by their run id. */
  private readonly running = new Map<string, AbortController>();

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly restic: ResticService,
    private readonly repositories: RepositoriesService,
  ) {}

  /**
   * Aborts a prune this process is running. Returns false when the run is
   * unknown here (already finished, or executed by an agent) — the caller then
   * has to settle the row itself.
   */
  cancel(runId: string): boolean {
    const ctrl = this.running.get(runId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  /**
   * Creates the prune activity and runs it to completion. Never rejects — the
   * outcome lives on the row. Resolves with the row id once the prune is done.
   */
  async run(opts: PruneRunOptions): Promise<string> {
    const id = await this.createRow(opts);
    await this.execute(id, opts);
    return id;
  }

  /** Creates the prune activity and runs it in the background; resolves with the row id at once. */
  async start(opts: PruneRunOptions): Promise<string> {
    const id = await this.createRow(opts);
    void this.execute(id, opts);
    return id;
  }

  /** Records a prune that an agent already ran as a finished activity. */
  async record(outcome: PruneOutcome): Promise<string> {
    const row = await this.db
      .insertInto('job_runs')
      .values({
        job_id: outcome.jobId,
        kind: 'prune',
        parent_run_id: outcome.parentRunId,
        trigger: outcome.trigger,
        agent_id: outcome.agentId,
        status: outcome.status,
        started_at: outcome.startedAt,
        finished_at: outcome.finishedAt,
        error: outcome.error ?? null,
        log: outcome.log ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (outcome.status === 'success' && !outcome.statsReported) {
      this.repositories.refreshStatsInBackground(outcome.repositoryId);
    }
    return row.id;
  }

  private async createRow(opts: PruneRunOptions): Promise<string> {
    const row = await this.db
      .insertInto('job_runs')
      .values({
        job_id: opts.jobId,
        kind: 'prune',
        parent_run_id: opts.parentRunId ?? null,
        trigger: opts.trigger,
        status: 'running',
        started_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  private async execute(id: string, opts: PruneRunOptions): Promise<void> {
    const logLines: string[] = [];
    const onLog = (line: string) => {
      logLines.push(line);
      if (logLines.length > MAX_LOG_LINES) logLines.shift();
    };
    const abort = new AbortController();
    this.running.set(id, abort);
    try {
      await this.restic.prune(opts.ctx, { onLog, signal: abort.signal });
      await this.db
        .updateTable('job_runs')
        .set({ status: 'success', finished_at: new Date(), log: logLines.join('\n') })
        .where('id', '=', id)
        .execute();
      // Prune just freed space — refresh the repository's cached figures.
      this.repositories.refreshStatsInBackground(opts.repositoryId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = abort.signal.aborted;
      this.logger.warn(`Prune ${id} ${aborted ? 'cancelled' : 'failed'}: ${message}`);
      await this.db
        .updateTable('job_runs')
        .set({
          status: aborted ? 'cancelled' : 'failed',
          finished_at: new Date(),
          error: message,
          log: logLines.join('\n'),
        })
        .where('id', '=', id)
        .execute()
        .catch(() => undefined);
    } finally {
      this.running.delete(id);
    }
  }
}
