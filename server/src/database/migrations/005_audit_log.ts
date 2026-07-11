import { Kysely, sql } from 'kysely';

/**
 * Append-only audit log of state-changing actions performed by authenticated
 * principals (users, admins, API keys): writes and operations alike — job runs,
 * restores, deletes, settings changes, enrollment, logins. Written by the global
 * AuditInterceptor and by explicit auth events. Secrets are redacted before
 * storage; `details` holds the (redacted) request body/params for drill-down.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('audit_log')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('actor_id', 'uuid')
    .addColumn('actor_email', 'text')
    .addColumn('actor_type', 'text', (c) => c.notNull())
    .addColumn('actor_is_admin', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('method', 'text')
    .addColumn('path', 'text')
    .addColumn('resource_type', 'text')
    .addColumn('resource_id', 'text')
    .addColumn('status_code', 'integer')
    .addColumn('outcome', 'text', (c) => c.notNull().defaultTo('success'))
    .addColumn('ip', 'text')
    .addColumn('user_agent', 'text')
    .addColumn('details', 'jsonb')
    .execute();

  await db.schema
    .createIndex('audit_log_created_at_idx')
    .on('audit_log')
    .column('created_at')
    .execute();
  await db.schema
    .createIndex('audit_log_actor_id_idx')
    .on('audit_log')
    .column('actor_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('audit_log').ifExists().execute();
}
