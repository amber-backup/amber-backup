import { Kysely, sql } from 'kysely';

/**
 * Automatic retries of failed backups.
 *
 * A job may retry a failed backup up to `retry_max` times, waiting
 * `retry_delay_seconds` before each attempt (0 retries = off, today's
 * behaviour). A retry is a new `job_runs` row queued right when its
 * predecessor failed: `attempt` counts from 1, `retry_of_run_id` points at the
 * failed run, and `not_before` holds it back until the delay has passed — so a
 * pending retry survives a server restart and is visible (and cancellable)
 * like any queued activity.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('backup_jobs')
    .addColumn('retry_max', 'integer', (c) =>
      c.notNull().defaultTo(0).check(sql`retry_max >= 0 and retry_max <= 10`),
    )
    .addColumn('retry_delay_seconds', 'integer', (c) =>
      c
        .notNull()
        .defaultTo(300)
        .check(sql`retry_delay_seconds >= 10 and retry_delay_seconds <= 86400`),
    )
    .execute();

  await db.schema
    .alterTable('job_runs')
    .addColumn('attempt', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('retry_of_run_id', 'uuid', (c) =>
      c.references('job_runs.id').onDelete('set null'),
    )
    .addColumn('not_before', 'timestamptz')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('job_runs')
    .dropColumn('not_before')
    .dropColumn('retry_of_run_id')
    .dropColumn('attempt')
    .execute();
  await db.schema
    .alterTable('backup_jobs')
    .dropColumn('retry_delay_seconds')
    .dropColumn('retry_max')
    .execute();
}
