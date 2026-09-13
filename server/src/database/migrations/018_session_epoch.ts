import { Kysely, sql } from 'kysely';

/**
 * Session invalidation on credential change.
 *
 * Session JWTs are stateless, so clearing the cookie or changing a password did
 * not revoke tokens already issued. A monotonically increasing `session_epoch`
 * is embedded in each session token and checked on every request; bumping it
 * (on password change/reset) invalidates all outstanding sessions for that user.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('users')
    .addColumn('session_epoch', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('session_epoch').execute();
  // Referenced to satisfy the unused-import lint in generated migration stubs.
  void sql;
}
