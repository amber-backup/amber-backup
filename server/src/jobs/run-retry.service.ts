import { Inject, Injectable, Logger } from '@nestjs/common';
import { Db, KYSELY } from '../database/database.module';
import { NotificationsService } from '../notifications/notifications.service';

/** Wait before a retry when a job does not set one. */
export const DEFAULT_RETRY_DELAY_SECONDS = 300;

/**
 * Settles a finished run: a failed backup whose job allows another attempt is
 * queued again (held back by `not_before` until the job's retry delay has
 * passed), everything else is notified as usual. A failure is thus only
 * reported once no retry follows it, while a pending retry lives in the
 * database — it survives a restart and can be cancelled like any queued run.
 */
@Injectable()
export class RunRetryService {
  private readonly logger = new Logger(RunRetryService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Call once a run has reached a terminal state. Queues a retry when one is
   * due, otherwise fires the configured notifications. Best-effort: never
   * throws.
   */
  async finalize(runId: string): Promise<void> {
    const retryId = await this.scheduleRetry(runId).catch((e) => {
      this.logger.error(`Could not schedule a retry for run ${runId}: ${e}`);
      return null;
    });
    if (retryId) return;
    await this.notifications
      .notifyJobRun(runId)
      .catch((e) => this.logger.warn(`Notify failed for run ${runId}: ${e}`));
  }

  /**
   * Queues the next attempt of a failed backup if its job has retries left.
   * Returns the new run's id, or null when no retry was queued.
   */
  async scheduleRetry(runId: string): Promise<string | null> {
    const run = await this.db
      .selectFrom('job_runs')
      .innerJoin('backup_jobs', 'backup_jobs.id', 'job_runs.job_id')
      .select([
        'job_runs.job_id',
        'job_runs.kind',
        'job_runs.status',
        'job_runs.trigger',
        'job_runs.attempt',
        'backup_jobs.retry_max',
        'backup_jobs.retry_delay_seconds',
      ])
      .where('job_runs.id', '=', runId)
      .executeTakeFirst();
    // Only real failures are retried — a cancelled run was stopped on purpose.
    if (!run || run.kind !== 'backup' || run.status !== 'failed') return null;
    // `attempt` counts the first try, so N retries allow N + 1 attempts.
    if (run.attempt > run.retry_max) return null;

    // A backup of the job already on its way (e.g. the next scheduled one)
    // makes a retry redundant.
    const active = await this.db
      .selectFrom('job_runs')
      .select('id')
      .where('job_id', '=', run.job_id)
      .where('kind', '=', 'backup')
      .where('status', 'in', ['queued', 'running'])
      .where('id', '!=', runId)
      .executeTakeFirst();
    if (active) return null;

    const attempt = run.attempt + 1;
    const notBefore = new Date(Date.now() + run.retry_delay_seconds * 1000);
    const retry = await this.db
      .insertInto('job_runs')
      .values({
        job_id: run.job_id,
        kind: 'backup',
        trigger: run.trigger,
        status: 'queued',
        attempt,
        retry_of_run_id: runId,
        not_before: notBefore,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    this.logger.log(
      `Run ${runId} failed — retry ${attempt - 1}/${run.retry_max} (run ${retry.id}) at ${notBefore.toISOString()}`,
    );
    return retry.id;
  }
}
