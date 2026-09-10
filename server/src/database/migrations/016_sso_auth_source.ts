import { Kysely, sql } from 'kysely';

/**
 * A local account can be converted to SSO.
 *
 * `auth_source` gains a generic 'sso' value. The SSO callback matches users by
 * e-mail and never records which provider someone came through, so the column
 * only ever meant "local or not"; 'oidc' and 'entra' stay valid for the rows
 * that already carry them and are treated exactly like 'sso'.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table users drop constraint if exists users_auth_source_check`.execute(
    db,
  );
  await sql`alter table users add constraint users_auth_source_check
    check (auth_source in ('local','oidc','entra','sso'))`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Fold the generic value back into the narrower set the constraint allows.
  await db
    .updateTable('users')
    .set({ auth_source: 'oidc' })
    .where('auth_source', '=', 'sso')
    .execute();
  await sql`alter table users drop constraint if exists users_auth_source_check`.execute(
    db,
  );
  await sql`alter table users add constraint users_auth_source_check
    check (auth_source in ('local','oidc','entra'))`.execute(db);
}
