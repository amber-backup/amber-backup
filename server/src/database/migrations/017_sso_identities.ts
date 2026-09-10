import { Kysely, sql } from 'kysely';

/**
 * Binds an SSO login to the identity the provider actually asserted.
 *
 * Until now the callback matched users by e-mail alone, so any configured
 * provider that claimed an address could sign in as the account holding it —
 * including a local, password-protected account. A row here records the
 * provider's immutable subject id (`sub`, or the numeric user id for GitHub)
 * for a user; the callback resolves by that pair first and only falls back to
 * the e-mail when linking an SSO account for the first time.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('sso_identities')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('provider_id', 'text', (c) => c.notNull())
    .addColumn('subject', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_login_at', 'timestamptz')
    .execute();

  await db.schema
    .createIndex('sso_identities_provider_subject_idx')
    .on('sso_identities')
    .columns(['provider_id', 'subject'])
    .unique()
    .execute();

  await db.schema
    .createIndex('sso_identities_user_id_idx')
    .on('sso_identities')
    .column('user_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('sso_identities').execute();
}
