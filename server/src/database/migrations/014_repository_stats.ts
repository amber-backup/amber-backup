import { Kysely, sql } from 'kysely';

/**
 * Cached repository figures (deduplicated size, snapshot count).
 *
 * Reading them live from restic on every list request would spawn one restic
 * process per repository, so the server refreshes them after each successful
 * backup run (and on demand) and stores the result here. `stats_at` is the
 * time of the last *successful* read; `stats_error` holds the last failure so
 * the UI can explain a stale or missing figure. `size_bytes` is a bigint —
 * pg returns it as a string.
 *
 * `repository_stats_history` keeps one row per *changed* reading so the
 * dashboard can chart storage growth over time. Rows go with their repository.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('repositories')
    .addColumn('size_bytes', 'bigint')
    .addColumn('snapshot_count', 'integer')
    .addColumn('stats_at', 'timestamptz')
    .addColumn('stats_error', 'text')
    .execute();

  await db.schema
    .createTable('repository_stats_history')
    .addColumn('id', 'uuid', (c) =>
      c.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('repository_id', 'uuid', (c) =>
      c.notNull().references('repositories.id').onDelete('cascade'),
    )
    .addColumn('measured_at', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn('size_bytes', 'bigint', (c) => c.notNull())
    .addColumn('snapshot_count', 'integer', (c) => c.notNull())
    .execute();

  await db.schema
    .createIndex('repository_stats_history_repo_time_idx')
    .on('repository_stats_history')
    .columns(['repository_id', 'measured_at'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('repository_stats_history').execute();
  await db.schema
    .alterTable('repositories')
    .dropColumn('stats_error')
    .dropColumn('stats_at')
    .dropColumn('snapshot_count')
    .dropColumn('size_bytes')
    .execute();
}
