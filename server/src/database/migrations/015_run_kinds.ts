import { Kysely, sql } from 'kysely';

/**
 * Prune becomes its own activity.
 *
 * Until now a job's retention step ran `restic forget --prune` inside the
 * backup run, so a slow prune was invisible: it only stretched the backup's
 * duration. `job_runs` now carries a `kind`: 'backup' rows are what they always
 * were, 'prune' rows record a `restic prune` with their own start/end, status
 * and log. A prune triggered by a backup's retention links to that backup via
 * `parent_run_id`; a prune requested when deleting a snapshot by hand has none.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('job_runs')
    .addColumn('kind', 'text', (c) =>
      c.notNull().defaultTo('backup').check(sql`kind in ('backup','prune')`),
    )
    .addColumn('parent_run_id', 'uuid', (c) =>
      c.references('job_runs.id').onDelete('cascade'),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.deleteFrom('job_runs').where('kind', '=', 'prune').execute();
  await db.schema
    .alterTable('job_runs')
    .dropColumn('parent_run_id')
    .dropColumn('kind')
    .execute();
}
