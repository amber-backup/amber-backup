import { Kysely, sql } from 'kysely';

/**
 * `repositories.initialized_at`: when Amber first saw this repository exist
 * (it initialised it, or found it in place before a backup). Together with a
 * successful backup / stats read / check it tells a backup that a missing
 * repository is an unmounted or unreachable target, not a new one to `init`.
 *
 * Backfilled for repositories that already held a successful backup or whose
 * figures or integrity were read.
 *
 * `repositories.relocated_at`: when the job last pointed the repository at
 * another location (connection or repository fields changed). Evidence older
 * than that belongs to the previous location and no longer counts, so a job
 * moved to a new, empty location may initialise it.
 *
 * Also: `restore_runs.repo_password_secret_id` becomes nullable with ON DELETE
 * SET NULL. A restore shares its job's password secret, and the RESTRICT
 * reference made deleting a job that had been restored from fail half-way
 * (job and repository gone, secret delete rejected → HTTP 500). The restore
 * history now survives the job, just without its password.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await dropRestorePasswordFk(db);
  await sql`ALTER TABLE restore_runs ALTER COLUMN repo_password_secret_id DROP NOT NULL`.execute(db);
  await sql`
    ALTER TABLE restore_runs
    ADD CONSTRAINT restore_runs_repo_password_secret_id_fkey
    FOREIGN KEY (repo_password_secret_id) REFERENCES secrets(id) ON DELETE SET NULL
  `.execute(db);

  await db.schema
    .alterTable('repositories')
    .addColumn('initialized_at', 'timestamptz')
    .addColumn('relocated_at', 'timestamptz')
    .execute();

  await sql`
    UPDATE repositories r
       SET initialized_at = now()
     WHERE r.stats_at IS NOT NULL
        OR r.check_at IS NOT NULL
        OR coalesce(r.snapshot_count, 0) > 0
        OR EXISTS (
             SELECT 1 FROM job_runs jr
               JOIN backup_jobs bj ON bj.id = jr.job_id
              WHERE bj.repository_id = r.id
                AND jr.kind = 'backup'
                AND jr.status = 'success')
        OR EXISTS (
             SELECT 1 FROM proxmox_job_guests g
               JOIN backup_jobs bj ON bj.id = g.job_id
              WHERE bj.repository_id = r.id
                AND g.last_snapshot_id IS NOT NULL)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('repositories')
    .dropColumn('initialized_at')
    .dropColumn('relocated_at')
    .execute();

  await dropRestorePasswordFk(db);
  // Restores whose job (and password) is gone cannot satisfy NOT NULL.
  await sql`DELETE FROM restore_runs WHERE repo_password_secret_id IS NULL`.execute(db);
  await sql`ALTER TABLE restore_runs ALTER COLUMN repo_password_secret_id SET NOT NULL`.execute(db);
  await sql`
    ALTER TABLE restore_runs
    ADD CONSTRAINT restore_runs_repo_password_secret_id_fkey
    FOREIGN KEY (repo_password_secret_id) REFERENCES secrets(id)
  `.execute(db);
}

/** Drops the FK on restore_runs.repo_password_secret_id, whatever its name. */
async function dropRestorePasswordFk(db: Kysely<any>): Promise<void> {
  await sql`
    DO $$
    DECLARE c RECORD;
    BEGIN
      FOR c IN
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_attribute att
            ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
         WHERE con.conrelid = 'restore_runs'::regclass
           AND con.contype = 'f'
           AND att.attname = 'repo_password_secret_id'
      LOOP
        EXECUTE format('ALTER TABLE restore_runs DROP CONSTRAINT %I', c.conname);
      END LOOP;
    END $$;
  `.execute(db);
}
