import { Kysely } from 'kysely';

/**
 * Reachability tracking for targets (backend connections). A periodic server
 * check probes each connection's endpoint and records the outcome here so the
 * UI can flag offline targets:
 *   - `status`: 'online' | 'offline' | 'unknown' (unknown = never checked or
 *     the backend has no probeable endpoint, e.g. rclone).
 *   - `last_check_at`: when the last probe ran.
 *   - `last_check_error`: why the last probe failed, null when online.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('targets')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('unknown'))
    .execute();
  await db.schema
    .alterTable('targets')
    .addColumn('last_check_at', 'timestamptz')
    .execute();
  await db.schema
    .alterTable('targets')
    .addColumn('last_check_error', 'text')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('targets').dropColumn('last_check_error').execute();
  await db.schema.alterTable('targets').dropColumn('last_check_at').execute();
  await db.schema.alterTable('targets').dropColumn('status').execute();
}
