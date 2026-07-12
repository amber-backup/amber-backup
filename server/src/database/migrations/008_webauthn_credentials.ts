import { Kysely, sql } from 'kysely';

/**
 * Registered WebAuthn/passkey credentials. Public keys are, by design, safe to
 * store in the clear. `counter` guards against cloned-authenticator replay;
 * `credential_id` is the unique Base64URL handle returned by the authenticator.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('webauthn_credentials')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('credential_id', 'text', (c) => c.notNull().unique())
    .addColumn('public_key', 'text', (c) => c.notNull())
    .addColumn('counter', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('transports', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('device_type', 'text')
    .addColumn('backed_up', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_used_at', 'timestamptz')
    .execute();

  await db.schema
    .createIndex('webauthn_credentials_user_id_idx')
    .on('webauthn_credentials')
    .column('user_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('webauthn_credentials').ifExists().execute();
}
