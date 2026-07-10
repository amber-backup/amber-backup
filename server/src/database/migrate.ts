/**
 * Standalone migration runner (optional; the server also migrates on startup).
 *   ts-node src/database/migrate.ts up      (apply all pending)
 *   ts-node src/database/migrate.ts down    (roll back the last)
 */
import { runMigrations } from './migrator';

async function main(): Promise<void> {
  const direction = (process.argv[2] as 'up' | 'down') ?? 'up';
  try {
    await runMigrations(direction, (m) => console.log(m));
    console.log('Migrations complete.');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

void main();
