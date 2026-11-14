import { Kysely, sql } from 'kysely';

/**
 * Proxmox VE: clusters whose VMs and containers Amber backs up.
 *
 * An agent runs on every PVE node and announces itself in its poll
 * (`agents.proxmox_info`: cluster id, cluster name, node). A cluster row links
 * all agents with its `pve_cluster_id`; its primary agent reads the inventory,
 * runs retention and is `backup_jobs.agent_id` of the cluster's jobs.
 *
 * A Proxmox run is split into `proxmox_run_items`, one guest each, handed to
 * the agent of the guest's node. `proxmox_job_guests` keeps each guest's last
 * snapshot (the next run's parent) and change-tracking state per job.
 *
 * Backup jobs gain source kind 'proxmox'; restores gain mode 'proxmox'.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('agents').addColumn('proxmox_info', 'jsonb').execute();

  await db.schema
    .createTable('proxmox_clusters')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('slug', 'text', (c) => c.notNull().unique())
    .addColumn('pve_cluster_id', 'text', (c) => c.notNull().unique())
    .addColumn('cluster_name', 'text')
    .addColumn('primary_agent_id', 'uuid', (c) =>
      c.notNull().references('agents.id').onDelete('restrict'),
    )
    .addColumn('inventory', 'jsonb')
    .addColumn('inventory_at', 'timestamptz')
    .addColumn('inventory_error', 'text')
    .addColumn('inventory_requested_at', 'timestamptz')
    .addColumn('owner_id', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .alterTable('backup_jobs')
    .addColumn('proxmox_cluster_id', 'uuid', (c) =>
      c.references('proxmox_clusters.id').onDelete('restrict'),
    )
    .addColumn('proxmox_config', 'jsonb')
    .execute();
  await sql`ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_source_kind_check`.execute(db);
  await sql`
    ALTER TABLE backup_jobs ADD CONSTRAINT backup_jobs_source_kind_check
    CHECK (source_kind in ('files','hyperv','proxmox'))
  `.execute(db);
  // 025 required a Hyper-V host for every non-file job; narrow it to Hyper-V.
  await sql`ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_hyperv_check`.execute(db);
  await sql`
    ALTER TABLE backup_jobs ADD CONSTRAINT backup_jobs_hyperv_check
    CHECK (source_kind <> 'hyperv' or (hyperv_host_id is not null and hyperv_config is not null and location = 'agent'))
  `.execute(db);
  await sql`
    ALTER TABLE backup_jobs ADD CONSTRAINT backup_jobs_proxmox_check
    CHECK (source_kind <> 'proxmox' or (proxmox_cluster_id is not null and proxmox_config is not null and location = 'agent'))
  `.execute(db);

  // Where a Proxmox run stands: 'items' (guests being backed up), 'retention'
  // (all settled, the finishing task is pending), 'retention_running', 'done'.
  await db.schema
    .alterTable('job_runs')
    .addColumn('proxmox_phase', 'text', (c) =>
      c.check(sql`proxmox_phase in ('items','retention','retention_running','done')`),
    )
    .addColumn('proxmox_phase_at', 'timestamptz')
    .execute();

  await db.schema
    .createTable('proxmox_run_items')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('run_id', 'uuid', (c) => c.notNull().references('job_runs.id').onDelete('cascade'))
    .addColumn('job_id', 'uuid', (c) => c.notNull().references('backup_jobs.id').onDelete('cascade'))
    .addColumn('vmid', 'integer', (c) => c.notNull())
    .addColumn('guest_type', 'text', (c) => c.notNull().check(sql`guest_type in ('qemu','lxc')`))
    .addColumn('name', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('node', 'text', (c) => c.notNull())
    .addColumn('agent_id', 'uuid', (c) => c.references('agents.id').onDelete('set null'))
    .addColumn('status', 'text', (c) =>
      c
        .notNull()
        .defaultTo('queued')
        .check(sql`status in ('queued','running','success','failed','skipped','cancelled')`),
    )
    .addColumn('method', 'text', (c) => c.check(sql`method in ('vzdump','block','files')`))
    .addColumn('moves', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('result', 'jsonb')
    .addColumn('progress', 'jsonb')
    .addColumn('error', 'text')
    .addColumn('log', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addUniqueConstraint('proxmox_run_items_run_vmid_unique', ['run_id', 'vmid'])
    .execute();
  await sql`CREATE INDEX proxmox_run_items_run_idx ON proxmox_run_items (run_id)`.execute(db);
  await sql`
    CREATE INDEX proxmox_run_items_open_idx ON proxmox_run_items (node, status)
    WHERE status in ('queued','running')
  `.execute(db);

  await db.schema
    .createTable('proxmox_job_guests')
    .addColumn('job_id', 'uuid', (c) => c.notNull().references('backup_jobs.id').onDelete('cascade'))
    .addColumn('vmid', 'integer', (c) => c.notNull())
    .addColumn('guest_type', 'text', (c) => c.notNull().check(sql`guest_type in ('qemu','lxc')`))
    .addColumn('name', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('last_snapshot_id', 'text')
    .addColumn('last_status', 'text')
    .addColumn('last_result', 'jsonb')
    .addColumn('last_finished_at', 'timestamptz')
    .addColumn('cbt', 'jsonb')
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('proxmox_job_guests_pk', ['job_id', 'vmid'])
    .execute();

  await sql`ALTER TABLE restore_runs DROP CONSTRAINT IF EXISTS restore_runs_mode_check`.execute(db);
  await sql`
    ALTER TABLE restore_runs ADD CONSTRAINT restore_runs_mode_check
    CHECK (mode in ('original','alternate_path','download','hyperv','proxmox'))
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM restore_runs WHERE mode = 'proxmox'`.execute(db);
  await sql`ALTER TABLE restore_runs DROP CONSTRAINT IF EXISTS restore_runs_mode_check`.execute(db);
  await sql`
    ALTER TABLE restore_runs ADD CONSTRAINT restore_runs_mode_check
    CHECK (mode in ('original','alternate_path','download','hyperv'))
  `.execute(db);

  await db.schema.dropTable('proxmox_job_guests').ifExists().execute();
  await db.schema.dropTable('proxmox_run_items').ifExists().execute();
  await db.schema
    .alterTable('job_runs')
    .dropColumn('proxmox_phase_at')
    .dropColumn('proxmox_phase')
    .execute();

  // Proxmox jobs have no file-based equivalent; they go with the feature.
  await sql`
    DELETE FROM job_runs WHERE job_id IN (SELECT id FROM backup_jobs WHERE source_kind = 'proxmox')
  `.execute(db);
  await sql`DELETE FROM backup_jobs WHERE source_kind = 'proxmox'`.execute(db);
  await sql`ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_proxmox_check`.execute(db);
  await sql`ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_hyperv_check`.execute(db);
  await sql`
    ALTER TABLE backup_jobs ADD CONSTRAINT backup_jobs_hyperv_check
    CHECK (source_kind = 'files' or (hyperv_host_id is not null and hyperv_config is not null and location = 'agent'))
  `.execute(db);
  await sql`ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_source_kind_check`.execute(db);
  await sql`
    ALTER TABLE backup_jobs ADD CONSTRAINT backup_jobs_source_kind_check
    CHECK (source_kind in ('files','hyperv'))
  `.execute(db);
  await db.schema
    .alterTable('backup_jobs')
    .dropColumn('proxmox_config')
    .dropColumn('proxmox_cluster_id')
    .execute();

  await db.schema.dropTable('proxmox_clusters').ifExists().execute();
  await db.schema.alterTable('agents').dropColumn('proxmox_info').execute();
}
