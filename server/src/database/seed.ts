/**
 * Standalone seed: ensures a bootstrap admin exists. The server also does this
 * on startup (UsersService.onModuleInit); this script is for manual/CI use.
 */
import * as argon2 from 'argon2';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { loadConfig } from '../config/configuration';
import { Database } from './database.types';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: config.databaseUrl }),
    }),
  });

  const existing = await db
    .selectFrom('users')
    .select('id')
    .limit(1)
    .executeTakeFirst();

  if (existing) {
    console.log('Users already present — nothing to seed.');
  } else if (config.bootstrapAdminEmail && config.bootstrapAdminPassword) {
    await db
      .insertInto('users')
      .values({
        email: config.bootstrapAdminEmail.toLowerCase(),
        display_name: 'Administrator',
        auth_source: 'local',
        password_hash: await argon2.hash(config.bootstrapAdminPassword),
        is_admin: true,
        disabled: false,
      })
      .execute();
    console.log(`Seeded admin: ${config.bootstrapAdminEmail}`);
  } else {
    console.log('BOOTSTRAP_ADMIN_EMAIL/PASSWORD not set — skipping.');
  }

  await db.destroy();
}

void main();
