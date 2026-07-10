import { Kysely, sql } from 'kysely';

/**
 * Merge sources into jobs: a job always had exactly one source, so the source
 * fields (location, agent, paths) move onto backup_jobs and the sources table
 * is dropped.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // Add embedded source fields (location nullable until backfilled).
  await db.schema
    .alterTable('backup_jobs')
    .addColumn('location', 'text')
    .addColumn('agent_id', 'uuid', (c) =>
      c.references('agents.id').onDelete('set null'),
    )
    .addColumn('paths', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .execute();

  // Backfill from the referenced source.
  await sql`
    UPDATE backup_jobs bj
    SET location = s.location,
        agent_id = s.agent_id,
        paths = s.paths
    FROM sources s
    WHERE bj.source_id = s.id
  `.execute(db);
  await sql`UPDATE backup_jobs SET location = 'local' WHERE location IS NULL`.execute(db);

  // Enforce constraints now that data is present.
  await db.schema
    .alterTable('backup_jobs')
    .alterColumn('location', (c) => c.setNotNull())
    .execute();
  await sql`
    ALTER TABLE backup_jobs
    ADD CONSTRAINT backup_jobs_location_check CHECK (location in ('local','agent'))
  `.execute(db);

  // Drop the old reference (this also drops its FK) and the sources table.
  await db.schema.alterTable('backup_jobs').dropColumn('source_id').execute();
  await db.schema.dropTable('sources').ifExists().execute();

  // Source-level grants no longer apply.
  await sql`DELETE FROM resource_grants WHERE resource_type = 'source'`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('sources')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('location', 'text', (c) =>
      c.notNull().check(sql`location in ('local','agent')`),
    )
    .addColumn('agent_id', 'uuid', (c) => c.references('agents.id').onDelete('set null'))
    .addColumn('paths', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('owner_id', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('tmp_job_id', 'uuid')
    .execute();

  await db.schema.alterTable('backup_jobs').addColumn('source_id', 'uuid').execute();

  // Recreate one source per job and relink.
  await sql`
    INSERT INTO sources (name, location, agent_id, paths, owner_id, tmp_job_id)
    SELECT bj.name || ' source', bj.location, bj.agent_id, bj.paths, bj.owner_id, bj.id
    FROM backup_jobs bj
  `.execute(db);
  await sql`
    UPDATE backup_jobs bj SET source_id = s.id
    FROM sources s WHERE s.tmp_job_id = bj.id
  `.execute(db);
  await db.schema.alterTable('sources').dropColumn('tmp_job_id').execute();

  await db.schema
    .alterTable('backup_jobs')
    .alterColumn('source_id', (c) => c.setNotNull())
    .execute();
  await sql`
    ALTER TABLE backup_jobs
    ADD CONSTRAINT backup_jobs_source_id_fkey FOREIGN KEY (source_id)
    REFERENCES sources(id) ON DELETE CASCADE
  `.execute(db);

  await db.schema.alterTable('backup_jobs').dropConstraint('backup_jobs_location_check').execute();
  await db.schema
    .alterTable('backup_jobs')
    .dropColumn('location')
    .dropColumn('agent_id')
    .dropColumn('paths')
    .execute();
}
