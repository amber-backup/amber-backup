import { Kysely, sql } from 'kysely';

/**
 * Repository integrity checks (`restic check`).
 *
 * A check is an activity of its own, like a prune: a `job_runs` row of kind
 * 'check' whose `check_info` records what was verified (level, and for a
 * rotating check which part of the data was read) and whether damage was found.
 *
 * The repository keeps the verdict so the UI can show it without reading runs:
 * `check_status` / `check_at` / `check_level` describe the last check that
 * reached a verdict ('passed' or 'damaged'); `check_error` holds why the most
 * recent attempt could not finish (cleared by the next verdict), so a lock or
 * network failure never hides a known-damaged repository. `data_verified_at`
 * is when all pack data was last read back successfully — by a full check or
 * by the last part of a completed rotation. `check_subset_next` /
 * `check_subset_parts` track the rotation (`--read-data-subset=next/parts`).
 *
 * The schedule lives on the job (`backup_jobs.integrity_check`).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE job_runs DROP CONSTRAINT IF EXISTS job_runs_kind_check`.execute(db);
  await sql`ALTER TABLE job_runs ADD CONSTRAINT job_runs_kind_check CHECK (kind in ('backup','prune','check'))`.execute(
    db,
  );
  await db.schema
    .alterTable('job_runs')
    .addColumn('check_info', 'jsonb')
    .execute();

  await db.schema
    .alterTable('repositories')
    .addColumn('check_status', 'text', (c) =>
      c.check(sql`check_status in ('passed','damaged')`),
    )
    .addColumn('check_at', 'timestamptz')
    .addColumn('check_level', 'text')
    .addColumn('check_error', 'text')
    .addColumn('data_verified_at', 'timestamptz')
    .addColumn('check_subset_next', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('check_subset_parts', 'integer')
    .execute();

  await db.schema
    .alterTable('backup_jobs')
    .addColumn('integrity_check', 'jsonb', (c) =>
      c.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('backup_jobs').dropColumn('integrity_check').execute();
  await db.schema
    .alterTable('repositories')
    .dropColumn('check_status')
    .dropColumn('check_at')
    .dropColumn('check_level')
    .dropColumn('check_error')
    .dropColumn('data_verified_at')
    .dropColumn('check_subset_next')
    .dropColumn('check_subset_parts')
    .execute();
  await db.deleteFrom('job_runs').where('kind', '=', 'check').execute();
  await db.schema.alterTable('job_runs').dropColumn('check_info').execute();
  await sql`ALTER TABLE job_runs DROP CONSTRAINT IF EXISTS job_runs_kind_check`.execute(db);
  await sql`ALTER TABLE job_runs ADD CONSTRAINT job_runs_kind_check CHECK (kind in ('backup','prune'))`.execute(
    db,
  );
}
