import { Kysely, sql } from 'kysely';

/**
 * Report definitions: a saved query over job_runs (which jobs, which outcomes,
 * over which time window) delivered to notification channels on a cron
 * schedule. Generation is driven by a dynamic CronJob per enabled report (see
 * ReportSchedulerService); `last_run_at` records the most recent delivery.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('reports')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('tags', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    // Dataset: { jobIds: string[], statuses: string[], window: string }.
    .addColumn('dataset', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('cron_expr', 'text', (c) => c.notNull())
    .addColumn('channel_ids', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('enabled', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('last_run_at', 'timestamptz')
    .addColumn('owner_id', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('reports_owner_id_idx')
    .on('reports')
    .column('owner_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('reports').ifExists().execute();
}
