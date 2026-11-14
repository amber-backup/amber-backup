import { Kysely, sql } from 'kysely';

/**
 * Leases for work handed to agents, so a run never stays `running` forever.
 *
 * - `heartbeat_at` on `job_runs`, `restore_runs` and `proxmox_run_items` is
 *   the last sign of life of a task an agent works on: set when it is claimed,
 *   on every progress post, on every task-state call (the agent asks every
 *   5 s while a task runs) and on every poll that lists the task as still
 *   held. A sweeper fails `running` rows whose heartbeat is too old.
 * - `agents.last_poll_at` is when the agent last polled (unlike
 *   `last_seen_at`, which any agent request refreshes). A poll that lists the
 *   agent's tasks fails those claimed before the previous poll that the agent
 *   no longer knows (it restarted, or the poll answer was lost).
 * - `agents.reports_running_tasks` remembers whether the agent sends that
 *   list; older agents get the more generous lease.
 * - `proxmox_run_items.queued_at` is when an item became claimable (created,
 *   or re-queued after its guest moved), the clock for the queue timeout.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('job_runs').addColumn('heartbeat_at', 'timestamptz').execute();
  await db.schema.alterTable('restore_runs').addColumn('heartbeat_at', 'timestamptz').execute();
  await db.schema
    .alterTable('proxmox_run_items')
    .addColumn('heartbeat_at', 'timestamptz')
    .addColumn('queued_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`UPDATE proxmox_run_items SET queued_at = created_at`.execute(db);

  await db.schema
    .alterTable('agents')
    .addColumn('last_poll_at', 'timestamptz')
    .addColumn('reports_running_tasks', 'boolean', (c) => c.notNull().defaultTo(false))
    .execute();

  // The sweepers look at open rows only; keep those lookups cheap.
  await sql`CREATE INDEX IF NOT EXISTS job_runs_open_idx ON job_runs (status) WHERE status IN ('queued', 'running')`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS restore_runs_open_idx ON restore_runs (status) WHERE status IN ('queued', 'running')`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS restore_runs_open_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS job_runs_open_idx`.execute(db);
  await db.schema
    .alterTable('agents')
    .dropColumn('reports_running_tasks')
    .dropColumn('last_poll_at')
    .execute();
  await db.schema
    .alterTable('proxmox_run_items')
    .dropColumn('queued_at')
    .dropColumn('heartbeat_at')
    .execute();
  await db.schema.alterTable('restore_runs').dropColumn('heartbeat_at').execute();
  await db.schema.alterTable('job_runs').dropColumn('heartbeat_at').execute();
}
