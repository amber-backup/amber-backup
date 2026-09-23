import { Kysely } from 'kysely';

/**
 * Pending stats refresh for a repository whose job runs on an agent. The
 * refresh button sets `stats_requested_at`; the agent's next poll claims it
 * (clearing the column) and runs `restic stats` on its own host, so the server
 * never has to read an agent-backed repository itself.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('repositories')
    .addColumn('stats_requested_at', 'timestamptz')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('repositories')
    .dropColumn('stats_requested_at')
    .execute();
}
