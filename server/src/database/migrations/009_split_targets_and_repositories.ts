import { Kysely, sql } from 'kysely';

/**
 * Split "target = connection + repository" into a shared connection (targets)
 * and a per-job repository. The repository-specific config (bucket, prefix,
 * path, container) and the restic repo password move from the target onto each
 * backup job, so one connection can serve many repositories. Restore runs get
 * their own snapshot of that repository config + password so they resolve
 * independently of the job's later lifetime. The `local` backend stops being a
 * target and becomes a per-job option (`target_id = NULL`).
 *
 * Backfill copies each target's password secret ciphertext/nonce verbatim (same
 * envelope key — no decryption needed), giving every job/restore its own copy.
 *
 * `down()` restores the schema structurally; it is inherently lossy for real
 * data (many jobs may have diverged from their former shared target) and is
 * intended primarily for a clean round-trip on an empty database.
 */

// Subset of a (formerly flat) target config that is repository-specific.
const repoConfigExpr = (alias: string) => sql`
  jsonb_strip_nulls(jsonb_build_object(
    'bucket', ${sql.ref(alias)}.config->'bucket',
    'prefix', ${sql.ref(alias)}.config->'prefix',
    'container', ${sql.ref(alias)}.config->'container',
    'path', ${sql.ref(alias)}.config->'path'
  ))
`;

export async function up(db: Kysely<any>): Promise<void> {
  // --- backup_jobs: add repository columns ---
  await db.schema
    .alterTable('backup_jobs')
    .addColumn('repo_config', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('repo_password_secret_id', 'uuid', (c) => c.references('secrets.id'))
    .execute();

  // target_id becomes nullable (null ⇒ local repo) and no longer cascade-deletes
  // jobs — a shared connection must not silently remove every job on it.
  await sql`ALTER TABLE backup_jobs DROP CONSTRAINT backup_jobs_target_id_fkey`.execute(db);
  await db.schema
    .alterTable('backup_jobs')
    .alterColumn('target_id', (c) => c.dropNotNull())
    .execute();
  await sql`
    ALTER TABLE backup_jobs
    ADD CONSTRAINT backup_jobs_target_id_fkey FOREIGN KEY (target_id)
    REFERENCES targets(id) ON DELETE RESTRICT
  `.execute(db);

  // Backfill repo_config from the (formerly flat) target config.
  await sql`
    UPDATE backup_jobs bj
    SET repo_config = COALESCE(
      (SELECT ${repoConfigExpr('t')} FROM targets t WHERE t.id = bj.target_id),
      '{}'::jsonb)
  `.execute(db);

  // Give each job its own copy of its target's repo password secret.
  await sql`
    DO $$
    DECLARE r RECORD; nid uuid;
    BEGIN
      FOR r IN SELECT bj.id AS job_id, t.password_secret_id AS ps
               FROM backup_jobs bj JOIN targets t ON t.id = bj.target_id
      LOOP
        INSERT INTO secrets (type, ciphertext, nonce)
          SELECT 'repo_password', s.ciphertext, s.nonce FROM secrets s WHERE s.id = r.ps
          RETURNING id INTO nid;
        UPDATE backup_jobs SET repo_password_secret_id = nid WHERE id = r.job_id;
      END LOOP;
    END $$;
  `.execute(db);

  // Local targets become local jobs (no connection). repo_config already carries
  // the path (extracted above).
  await sql`
    UPDATE backup_jobs SET target_id = NULL
    WHERE target_id IN (SELECT id FROM targets WHERE backend_type = 'local')
  `.execute(db);

  await db.schema
    .alterTable('backup_jobs')
    .alterColumn('repo_password_secret_id', (c) => c.setNotNull())
    .execute();

  // --- restore_runs: snapshot repository resolution ---
  await db.schema
    .alterTable('restore_runs')
    .addColumn('job_id', 'uuid', (c) =>
      c.references('backup_jobs.id').onDelete('set null'),
    )
    .addColumn('repo_config', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('repo_password_secret_id', 'uuid', (c) => c.references('secrets.id'))
    .execute();

  // Keep restore history when a target is deleted.
  await sql`ALTER TABLE restore_runs DROP CONSTRAINT restore_runs_target_id_fkey`.execute(db);
  await db.schema
    .alterTable('restore_runs')
    .alterColumn('target_id', (c) => c.dropNotNull())
    .execute();
  await sql`
    ALTER TABLE restore_runs
    ADD CONSTRAINT restore_runs_target_id_fkey FOREIGN KEY (target_id)
    REFERENCES targets(id) ON DELETE SET NULL
  `.execute(db);

  await sql`
    UPDATE restore_runs rr
    SET repo_config = COALESCE(
      (SELECT ${repoConfigExpr('t')} FROM targets t WHERE t.id = rr.target_id),
      '{}'::jsonb)
  `.execute(db);
  // Best-effort provenance: any job on the same connection.
  await sql`
    UPDATE restore_runs rr
    SET job_id = (SELECT bj.id FROM backup_jobs bj WHERE bj.target_id = rr.target_id LIMIT 1)
  `.execute(db);
  await sql`
    DO $$
    DECLARE r RECORD; nid uuid;
    BEGIN
      FOR r IN SELECT rr.id AS run_id, t.password_secret_id AS ps
               FROM restore_runs rr JOIN targets t ON t.id = rr.target_id
      LOOP
        INSERT INTO secrets (type, ciphertext, nonce)
          SELECT 'repo_password', s.ciphertext, s.nonce FROM secrets s WHERE s.id = r.ps
          RETURNING id INTO nid;
        UPDATE restore_runs SET repo_password_secret_id = nid WHERE id = r.run_id;
      END LOOP;
    END $$;
  `.execute(db);
  await db.schema
    .alterTable('restore_runs')
    .alterColumn('repo_password_secret_id', (c) => c.setNotNull())
    .execute();

  // --- targets: strip moved fields, drop the repo password ---
  await sql`
    UPDATE targets
    SET config = config - 'bucket' - 'prefix' - 'container' - 'path'
  `.execute(db);

  await sql`
    DELETE FROM resource_grants
    WHERE resource_type = 'target'
      AND resource_id IN (SELECT id FROM targets WHERE backend_type = 'local')
  `.execute(db);
  // restore_runs.target_id is ON DELETE SET NULL, so this nulls their reference.
  await sql`DELETE FROM targets WHERE backend_type = 'local'`.execute(db);

  await db.schema.alterTable('targets').dropColumn('password_secret_id').execute();

  // The original per-target passwords were copied into jobs/restores; the
  // originals are now referenced by nothing and can be removed.
  await sql`
    DELETE FROM secrets
    WHERE type = 'repo_password'
      AND id NOT IN (SELECT repo_password_secret_id FROM backup_jobs WHERE repo_password_secret_id IS NOT NULL)
      AND id NOT IN (SELECT repo_password_secret_id FROM restore_runs WHERE repo_password_secret_id IS NOT NULL)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Structural rollback (lossy for real data; clean on an empty database).

  // --- targets: restore password column, best-effort backfill ---
  await db.schema
    .alterTable('targets')
    .addColumn('password_secret_id', 'uuid', (c) => c.references('secrets.id'))
    .execute();
  // Copy a repo password from any job on the target, where one exists.
  await sql`
    DO $$
    DECLARE r RECORD; nid uuid;
    BEGIN
      FOR r IN SELECT t.id AS tid,
                      (SELECT bj.repo_password_secret_id FROM backup_jobs bj
                       WHERE bj.target_id = t.id LIMIT 1) AS ps
               FROM targets t
      LOOP
        IF r.ps IS NOT NULL THEN
          INSERT INTO secrets (type, ciphertext, nonce)
            SELECT 'repo_password', s.ciphertext, s.nonce FROM secrets s WHERE s.id = r.ps
            RETURNING id INTO nid;
          UPDATE targets SET password_secret_id = nid WHERE id = r.tid;
        END IF;
      END LOOP;
    END $$;
  `.execute(db);
  // Fold repo_config back into the target config (first job wins).
  await sql`
    UPDATE targets t
    SET config = t.config || COALESCE(
      (SELECT bj.repo_config FROM backup_jobs bj WHERE bj.target_id = t.id LIMIT 1),
      '{}'::jsonb)
  `.execute(db);
  await db.schema
    .alterTable('targets')
    .alterColumn('password_secret_id', (c) => c.setNotNull())
    .execute();

  // --- restore_runs ---
  await sql`ALTER TABLE restore_runs DROP CONSTRAINT restore_runs_target_id_fkey`.execute(db);
  await db.schema
    .alterTable('restore_runs')
    .dropColumn('job_id')
    .dropColumn('repo_config')
    .dropColumn('repo_password_secret_id')
    .execute();
  await db.schema
    .alterTable('restore_runs')
    .alterColumn('target_id', (c) => c.setNotNull())
    .execute();
  await sql`
    ALTER TABLE restore_runs
    ADD CONSTRAINT restore_runs_target_id_fkey FOREIGN KEY (target_id)
    REFERENCES targets(id) ON DELETE CASCADE
  `.execute(db);

  // --- backup_jobs ---
  await sql`ALTER TABLE backup_jobs DROP CONSTRAINT backup_jobs_target_id_fkey`.execute(db);
  await db.schema
    .alterTable('backup_jobs')
    .dropColumn('repo_config')
    .dropColumn('repo_password_secret_id')
    .execute();
  await db.schema
    .alterTable('backup_jobs')
    .alterColumn('target_id', (c) => c.setNotNull())
    .execute();
  await sql`
    ALTER TABLE backup_jobs
    ADD CONSTRAINT backup_jobs_target_id_fkey FOREIGN KEY (target_id)
    REFERENCES targets(id) ON DELETE CASCADE
  `.execute(db);
}
