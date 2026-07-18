import { Kysely, sql } from 'kysely';

const TABLES = [
  'targets',
  'repositories',
  'agents',
  'backup_jobs',
  'notification_channels',
  'reports',
] as const;

/**
 * Adds a name-derived `slug` to every named entity. Slugs are lowercase
 * kebab-case, unique per table (numeric `-N` suffix on collisions), maintained
 * by the application on create/rename, and never editable through the API —
 * they exist so the CLI/API can address an entity by slug instead of UUID.
 *
 * Existing rows are backfilled with the same rules the runtime `uniqueSlug`
 * helper applies: base = lowercase kebab-case of `name` ('entity' when nothing
 * usable remains), duplicates get `-2`, `-3`, … in creation order.
 */
export async function up(db: Kysely<any>): Promise<void> {
  for (const table of TABLES) {
    await db.schema.alterTable(table).addColumn('slug', 'text').execute();
  }

  for (const table of TABLES) {
    await sql`
      UPDATE ${sql.table(table)} t
      SET slug = x.slug
      FROM (
        SELECT id,
               CASE WHEN rn > 1 THEN base || '-' || rn ELSE base END AS slug
        FROM (
          SELECT id, base,
                 row_number() OVER (PARTITION BY base ORDER BY created_at, id) AS rn
          FROM (
            SELECT id, created_at,
                   COALESCE(
                     NULLIF(trim(both '-' from lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))), ''),
                     'entity'
                   ) AS base
            FROM ${sql.table(table)}
          ) s
        ) b
      ) x
      WHERE t.id = x.id
    `.execute(db);

    await db.schema
      .alterTable(table)
      .alterColumn('slug', (c) => c.setNotNull())
      .execute();

    await db.schema
      .createIndex(`${table}_slug_unique`)
      .on(table)
      .column('slug')
      .unique()
      .execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of TABLES) {
    await db.schema.dropIndex(`${table}_slug_unique`).execute();
    await db.schema.alterTable(table).dropColumn('slug').execute();
  }
}
