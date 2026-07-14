import { Kysely, sql } from 'kysely';

/**
 * Promote each backup job's embedded repository into a first-class
 * `repositories` table. Until now a repository was three columns on
 * `backup_jobs` (`target_id`, `repo_config`, `repo_password_secret_id`); this
 * migration moves them into their own table, one row per job (1:1), and points
 * the job at it via `repository_id`.
 *
 * The UI/API keep behaving exactly as before: the jobs service reconstructs
 * `target_id`/`repo_config` by joining the repository, so job read/write shapes
 * are unchanged. Restore runs keep their own snapshotted repository columns
 * (untouched here) so historical restores stay self-contained.
 *
 * `down()` restores the schema structurally; it is lossy for real data (a
 * repository shared conceptually is still 1:1 here) and intended for a clean
 * round-trip on an empty database.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // --- repositories: one per job, carrying the former embedded columns ---
  await db.schema
    .createTable('repositories')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    // Shared connection this repository lives on; null ⇒ local filesystem repo.
    // RESTRICT mirrors the guard that used to sit on backup_jobs.target_id.
    .addColumn('target_id', 'uuid', (c) =>
      c.references('targets.id').onDelete('restrict'),
    )
    .addColumn('repo_config', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('repo_password_secret_id', 'uuid', (c) =>
      c.notNull().references('secrets.id'),
    )
    .addColumn('owner_id', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // --- backup_jobs: reference the repository ---
  await db.schema
    .alterTable('backup_jobs')
    .addColumn('repository_id', 'uuid', (c) =>
      c.references('repositories.id').onDelete('restrict'),
    )
    .execute();

  // Backfill one repository per job, preserving the job's own metadata, then
  // link the job to it.
  await sql`
    DO $$
    DECLARE r RECORD; rid uuid;
    BEGIN
      FOR r IN SELECT id, name, target_id, repo_config,
                      repo_password_secret_id, owner_id, created_at, updated_at
               FROM backup_jobs
      LOOP
        INSERT INTO repositories
          (name, target_id, repo_config, repo_password_secret_id, owner_id, created_at, updated_at)
        VALUES
          (r.name, r.target_id, r.repo_config, r.repo_password_secret_id, r.owner_id, r.created_at, r.updated_at)
        RETURNING id INTO rid;
        UPDATE backup_jobs SET repository_id = rid WHERE id = r.id;
      END LOOP;
    END $$;
  `.execute(db);

  await db.schema
    .alterTable('backup_jobs')
    .alterColumn('repository_id', (c) => c.setNotNull())
    .execute();

  // Drop the now-migrated embedded columns (their FKs drop with them).
  await db.schema
    .alterTable('backup_jobs')
    .dropColumn('target_id')
    .dropColumn('repo_config')
    .dropColumn('repo_password_secret_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Re-add the embedded columns (nullable first for the backfill).
  await db.schema
    .alterTable('backup_jobs')
    .addColumn('target_id', 'uuid', (c) =>
      c.references('targets.id').onDelete('restrict'),
    )
    .addColumn('repo_config', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('repo_password_secret_id', 'uuid', (c) => c.references('secrets.id'))
    .execute();

  // Fold each job's repository back onto the job.
  await sql`
    UPDATE backup_jobs bj
    SET target_id = r.target_id,
        repo_config = r.repo_config,
        repo_password_secret_id = r.repo_password_secret_id
    FROM repositories r
    WHERE r.id = bj.repository_id
  `.execute(db);

  await db.schema
    .alterTable('backup_jobs')
    .alterColumn('repo_password_secret_id', (c) => c.setNotNull())
    .execute();

  await db.schema.alterTable('backup_jobs').dropColumn('repository_id').execute();
  await db.schema.dropTable('repositories').execute();
}
