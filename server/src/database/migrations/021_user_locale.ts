import { Kysely, sql } from 'kysely';

/**
 * Per-user UI language. Null means "follow the browser", so existing users keep
 * today's behaviour until they pick a language in their settings.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('users')
    .addColumn('locale', 'text', (c) => c.check(sql`locale in ('en','de')`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('locale').execute();
}
