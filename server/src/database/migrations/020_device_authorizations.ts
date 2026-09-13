import { Kysely, sql } from 'kysely';

/**
 * Device authorization for the CLI (`ambb login`), modelled on the OAuth 2.0
 * device authorization grant (RFC 8628).
 *
 * The CLI requests a pairing and receives a secret `device_code` plus a short
 * `user_code`; a signed-in user confirms the user code in the web UI, and the
 * CLI's next poll exchanges the device code for a freshly minted API key. Both
 * codes are stored only as SHA-256 hashes. The API key's plaintext is generated
 * at exchange time and never stored, so an approved-but-unclaimed row holds no
 * credential. `api_key_id` links the issued key for traceability.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('device_authorizations')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('device_code_hash', 'text', (c) => c.notNull().unique())
    .addColumn('user_code_hash', 'text', (c) => c.notNull().unique())
    .addColumn('client_name', 'text', (c) => c.notNull())
    .addColumn('request_ip', 'text')
    .addColumn('request_user_agent', 'text')
    .addColumn('status', 'text', (c) =>
      c
        .notNull()
        .defaultTo('pending')
        .check(sql`status in ('pending','approved','denied','consumed')`),
    )
    .addColumn('user_id', 'uuid', (c) => c.references('users.id').onDelete('cascade'))
    .addColumn('access', 'text', (c) => c.check(sql`access in ('full','read')`))
    .addColumn('key_expires_in_days', 'integer')
    .addColumn('api_key_id', 'uuid', (c) => c.references('api_keys.id').onDelete('set null'))
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('last_polled_at', 'timestamptz')
    .addColumn('decided_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('device_authorizations').execute();
}
