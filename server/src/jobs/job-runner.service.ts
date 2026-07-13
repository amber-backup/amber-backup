import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Db, KYSELY } from '../database/database.module';
import { ResticService } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ResticOptions, RunStats } from '../database/database.types';

const execFileAsync = promisify(execFile);

/** How long a single pre/post script may run before it is killed. */
const SCRIPT_TIMEOUT_MS = 300_000;

/**
 * Executes local backup runs end-to-end: backup → forget/prune (§7) with live
 * progress written to job_runs. Agent-bound runs are left queued for the agent
 * to pick up on its next poll.
 */
@Injectable()
export class JobRunnerService implements OnApplicationShutdown {
  private readonly logger = new Logger(JobRunnerService.name);
  private readonly running = new Map<string, AbortController>();

  /** Abort in-flight runs on shutdown so restic children don't block exit. */
  onApplicationShutdown(): void {
    for (const ctrl of this.running.values()) ctrl.abort();
  }

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly restic: ResticService,
    private readonly targets: TargetsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Dispatches a queued run: run locally now, or leave it for an agent. */
  async dispatch(jobRunId: string): Promise<void> {
    const run = await this.db
      .selectFrom('job_runs')
      .innerJoin('backup_jobs', 'backup_jobs.id', 'job_runs.job_id')
      .select([
        'job_runs.id as run_id',
        'backup_jobs.location',
        'backup_jobs.agent_id',
      ])
      .where('job_runs.id', '=', jobRunId)
      .executeTakeFirst();
    if (!run) return;

    if (run.location === 'local') {
      // Fire and forget; errors are recorded on the run itself.
      void this.executeLocal(jobRunId).catch((e) =>
        this.logger.error(`Run ${jobRunId} failed: ${e}`),
      );
    }
    // Agent-bound runs stay 'queued' until the agent polls (§8).
  }

  cancel(jobRunId: string): boolean {
    const ctrl = this.running.get(jobRunId);
    if (ctrl) {
      ctrl.abort();
      return true;
    }
    return false;
  }

  async executeLocal(jobRunId: string): Promise<void> {
    const ctx = await this.loadRunContext(jobRunId);
    if (!ctx) return;
    const { job, source, targetId, options } = ctx;

    const abort = new AbortController();
    this.running.set(jobRunId, abort);
    const logLines: string[] = [];
    const appendLog = (line: string) => {
      logLines.push(line);
      if (logLines.length > 1000) logLines.shift();
    };

    await this.db
      .updateTable('job_runs')
      .set({ status: 'running', started_at: new Date() })
      .where('id', '=', jobRunId)
      .execute();

    try {
      const resolved = await this.targets.resolve(targetId);
      const resticCtx = {
        repository: resolved.repository,
        password: resolved.password,
        env: resolved.env,
        credentialFiles: resolved.credentialFiles,
        extraArgs: resolved.extraArgs,
      };

      // Pre-backup script gates the run: a non-zero exit throws and aborts the
      // backup (the catch below records the failure and runs the failure script).
      if (options.preScript) {
        appendLog(`[pre-script] ${options.preScript}`);
        await this.runScript(
          options.preScript,
          this.scriptEnv(job, jobRunId, source.paths, { AMBER_HOOK: 'pre' }),
          appendLog,
        );
      }

      await this.restic.ensureInitialized(resticCtx);

      let lastWrite = 0;
      const backup = await this.restic.backup(
        resticCtx,
        source.paths,
        options,
        {
          onProgress: (stats) => {
            const now = Date.now();
            if (now - lastWrite > 1000) {
              lastWrite = now;
              void this.writeStats(jobRunId, stats);
            }
          },
          onLog: appendLog,
        },
        abort.signal,
      );

      // Retention as part of the run (§7).
      let forgetResult: unknown = null;
      if (options.retention && this.hasRetention(options.retention)) {
        const fr = await this.restic.forget(resticCtx, options.retention, {
          onLog: appendLog,
        });
        forgetResult = fr.raw;
        appendLog(`[forget] removed ${fr.removed} snapshot(s)`);
      }

      // On-success script runs after a successful backup+forget. It is not
      // allowed to fail the run — the data is already safe — so its error is
      // only logged.
      if (options.postSuccessScript) {
        appendLog(`[post-success-script] ${options.postSuccessScript}`);
        try {
          await this.runScript(
            options.postSuccessScript,
            this.scriptEnv(job, jobRunId, source.paths, {
              AMBER_HOOK: 'post-success',
              AMBER_STATUS: 'success',
              AMBER_SNAPSHOT_ID: backup.snapshotId ?? '',
            }),
            appendLog,
          );
        } catch (e) {
          appendLog(`[post-success-script] ${e instanceof Error ? e.message : e}`);
        }
      }

      await this.db
        .updateTable('job_runs')
        .set({
          status: 'success',
          finished_at: new Date(),
          snapshot_id: backup.snapshotId,
          stats: JSON.stringify(backup.stats),
          forget_result: forgetResult ? JSON.stringify(forgetResult) : null,
          log: logLines.join('\n'),
        })
        .where('id', '=', jobRunId)
        .execute();
    } catch (err) {
      const aborted = abort.signal.aborted;
      appendLog(String(err));
      // On-failure script runs after any real failure (including a failed
      // pre-script), but not when the user cancelled the run. Best-effort.
      if (!aborted && options.postFailureScript) {
        appendLog(`[post-failure-script] ${options.postFailureScript}`);
        try {
          await this.runScript(
            options.postFailureScript,
            this.scriptEnv(job, jobRunId, source.paths, {
              AMBER_HOOK: 'post-failure',
              AMBER_STATUS: 'failed',
              AMBER_ERROR: err instanceof Error ? err.message : String(err),
            }),
            appendLog,
          );
        } catch (e) {
          appendLog(`[post-failure-script] ${e instanceof Error ? e.message : e}`);
        }
      }
      await this.db
        .updateTable('job_runs')
        .set({
          status: aborted ? 'cancelled' : 'failed',
          finished_at: new Date(),
          error: err instanceof Error ? err.message : String(err),
          log: logLines.join('\n'),
        })
        .where('id', '=', jobRunId)
        .execute();
    } finally {
      this.running.delete(jobRunId);
      // Fire configured notifications for the now-terminal run (best-effort).
      void this.notifications
        .notifyJobRun(jobRunId)
        .catch((e) => this.logger.warn(`Notify failed for run ${jobRunId}: ${e}`));
    }
  }

  private hasRetention(r: NonNullable<ResticOptions['retention']>): boolean {
    return Object.values(r).some((v) =>
      Array.isArray(v) ? v.length > 0 : v != null && v !== false,
    );
  }

  private async writeStats(jobRunId: string, stats: RunStats): Promise<void> {
    await this.db
      .updateTable('job_runs')
      .set({ stats: JSON.stringify(stats) })
      .where('id', '=', jobRunId)
      .execute()
      .catch(() => undefined);
  }

  /** Environment handed to a job script: process env plus AMBER_* context. */
  private scriptEnv(
    job: { id: string; name: string },
    runId: string,
    paths: string[],
    extra: Record<string, string>,
  ): NodeJS.ProcessEnv {
    return {
      ...process.env,
      AMBER_JOB_ID: job.id,
      AMBER_JOB_NAME: job.name,
      AMBER_RUN_ID: runId,
      AMBER_PATHS: paths.join('\n'),
      ...extra,
    };
  }

  /**
   * Runs a job script by path, directly (no shell, no arguments), capturing its
   * output into the run log. Throws on a non-zero exit or timeout so callers can
   * decide whether that gates the run.
   */
  private async runScript(
    scriptPath: string,
    env: NodeJS.ProcessEnv,
    appendLog: (line: string) => void,
  ): Promise<void> {
    try {
      const { stdout, stderr } = await execFileAsync(scriptPath, [], {
        timeout: SCRIPT_TIMEOUT_MS,
        env,
      });
      if (stdout.trim()) appendLog(stdout.trim());
      if (stderr.trim()) appendLog(stderr.trim());
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      if (err.stdout?.trim()) appendLog(err.stdout.trim());
      if (err.stderr?.trim()) appendLog(err.stderr.trim());
      throw new Error(`Script failed: ${err.message ?? String(e)}`);
    }
  }

  private async loadRunContext(jobRunId: string) {
    const row = await this.db
      .selectFrom('job_runs')
      .innerJoin('backup_jobs', 'backup_jobs.id', 'job_runs.job_id')
      .select([
        'job_runs.id as run_id',
        'backup_jobs.id as job_id',
        'backup_jobs.name as job_name',
        'backup_jobs.target_id',
        'backup_jobs.restic_options',
        'backup_jobs.location',
        'backup_jobs.paths',
      ])
      .where('job_runs.id', '=', jobRunId)
      .executeTakeFirst();
    if (!row || row.location !== 'local') return null;

    const options: ResticOptions =
      typeof row.restic_options === 'string'
        ? JSON.parse(row.restic_options)
        : row.restic_options;
    const paths: string[] =
      typeof row.paths === 'string' ? JSON.parse(row.paths) : (row.paths as string[]);

    return {
      job: { id: row.job_id, name: row.job_name },
      source: { paths },
      targetId: row.target_id,
      options,
    };
  }
}
