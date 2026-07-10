import * as path from 'path';
import { promises as fs } from 'fs';
import {
  FileMigrationProvider,
  Kysely,
  Migrator,
  PostgresDialect,
} from 'kysely';
import { Pool } from 'pg';
import { loadConfig } from '../config/configuration';
import { Database } from './database.types';

/**
 * Applies (or rolls back) migrations using a short-lived connection. Shared by
 * the CLI (`migrate.ts`) and the app bootstrap so migrations run on startup.
 */
export async function runMigrations(
  direction: 'up' | 'down' = 'up',
  log: (message: string) => void = console.log,
): Promise<void> {
  const config = loadConfig();
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: config.databaseUrl }),
    }),
  });
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      // Resolves relative to this module: dist/database/migrations.
      migrationFolder: path.join(__dirname, 'migrations'),
    }),
  });

  try {
    const { error, results } =
      direction === 'down'
        ? await migrator.migrateDown()
        : await migrator.migrateToLatest();

    results?.forEach((it) => {
      if (it.status === 'Success') {
        log(`✓ ${it.direction} "${it.migrationName}"`);
      } else if (it.status === 'Error') {
        log(`✗ failed "${it.migrationName}"`);
      }
    });

    if (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  } finally {
    await db.destroy();
  }
}
