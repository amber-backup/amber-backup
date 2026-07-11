import { Kysely, sql } from 'kysely';

/**
 * Key/value application settings. Currently holds the global agent enrollment
 * config (`global_enrollment`): whether self-registration is enabled and the
 * shared enrollment token, encrypted at rest. Agents present this token only to
 * exchange it for their own long-lived credential — it is never a poll credential.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('app_settings')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'jsonb', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('app_settings').ifExists().execute();
}
