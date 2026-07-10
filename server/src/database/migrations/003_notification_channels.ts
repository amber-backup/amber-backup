import { Kysely, sql } from 'kysely';

/**
 * Notification channels (email, webhook, slack, teams, discord, telegram,
 * gotify) and their wiring onto jobs. Non-secret provider config lives on the
 * row; provider secrets are stored encrypted in the shared secrets table, so
 * its type CHECK must learn the new 'notification_credential' type.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // Allow notification credentials in the secrets type CHECK.
  await sql`ALTER TABLE secrets DROP CONSTRAINT IF EXISTS secrets_type_check`.execute(db);
  await sql`
    ALTER TABLE secrets
    ADD CONSTRAINT secrets_type_check
    CHECK (type in ('repo_password','backend_credential','notification_credential'))
  `.execute(db);

  await db.schema
    .createTable('notification_channels')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('config', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('secret_id', 'uuid', (c) => c.references('secrets.id'))
    .addColumn('enabled', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('owner_id', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // Which channels a job notifies, and on which outcomes.
  await db.schema
    .alterTable('backup_jobs')
    .addColumn('notify', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('backup_jobs').dropColumn('notify').execute();
  await db.schema.dropTable('notification_channels').ifExists().execute();

  // Note: leaves any orphaned notification_credential secrets; restore the
  // narrower CHECK only if none remain.
  await sql`DELETE FROM secrets WHERE type = 'notification_credential'`.execute(db);
  await sql`ALTER TABLE secrets DROP CONSTRAINT IF EXISTS secrets_type_check`.execute(db);
  await sql`
    ALTER TABLE secrets
    ADD CONSTRAINT secrets_type_check
    CHECK (type in ('repo_password','backend_credential'))
  `.execute(db);
}
