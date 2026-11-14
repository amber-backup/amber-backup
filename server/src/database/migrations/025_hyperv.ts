import { Kysely, sql } from 'kysely';

/**
 * Hyper-V: hosts whose virtual machines Amber backs up.
 *
 * A failover cluster is a host of mode 'cluster': its address is the cluster
 * name, and the agent reaches each VM through its current owner node with the
 * stored credentials (like a remote host).
 *
 * A host is reached through a Windows agent: in `local` mode the agent runs on
 * the Hyper-V host itself; in `remote` mode a proxy agent drives the host over
 * PowerShell remoting with stored credentials (secret type
 * 'hyperv_credential') and reads the disks over SMB. The agent reports the
 * host's VM inventory, cached on the row.
 *
 * Backup jobs gain a source kind: 'files' (paths, as before) or 'hyperv' (VMs
 * of one host, `hyperv_config`). A Hyper-V job runs on the host's agent, so it
 * keeps location = 'agent' and agent_id = the host's agent.
 *
 * Restores gain the 'hyperv' mode (register a VM, or restore its disks).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE secrets DROP CONSTRAINT IF EXISTS secrets_type_check`.execute(db);
  await sql`
    ALTER TABLE secrets
    ADD CONSTRAINT secrets_type_check
    CHECK (type in ('repo_password','backend_credential','notification_credential','hyperv_credential'))
  `.execute(db);

  await db.schema
    .createTable('hyperv_hosts')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('slug', 'text', (c) => c.notNull().unique())
    .addColumn('mode', 'text', (c) =>
      c.notNull().defaultTo('local').check(sql`mode in ('local','remote','cluster')`),
    )
    // The agent that runs on the host (local) or proxies it (remote).
    .addColumn('agent_id', 'uuid', (c) =>
      c.notNull().references('agents.id').onDelete('restrict'),
    )
    // remote: the host's DNS name / address and the credential to reach it.
    .addColumn('address', 'text')
    .addColumn('credential_secret_id', 'uuid', (c) =>
      c.references('secrets.id').onDelete('restrict'),
    )
    .addColumn('inventory', 'jsonb')
    .addColumn('inventory_at', 'timestamptz')
    .addColumn('inventory_error', 'text')
    // Set to ask the agent for a fresh inventory on its next poll.
    .addColumn('inventory_requested_at', 'timestamptz')
    .addColumn('owner_id', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'hyperv_hosts_remote_check',
      sql`mode = 'local' or (address is not null and credential_secret_id is not null)`,
    )
    .execute();
  // A host is driven by one agent; one agent can proxy several remote hosts
  // but runs on at most one local host.
  await sql`
    CREATE UNIQUE INDEX hyperv_hosts_local_agent_idx
    ON hyperv_hosts (agent_id) WHERE mode = 'local'
  `.execute(db);

  await db.schema
    .alterTable('backup_jobs')
    .addColumn('source_kind', 'text', (c) =>
      c.notNull().defaultTo('files').check(sql`source_kind in ('files','hyperv')`),
    )
    .addColumn('hyperv_host_id', 'uuid', (c) =>
      c.references('hyperv_hosts.id').onDelete('restrict'),
    )
    .addColumn('hyperv_config', 'jsonb')
    .execute();
  await sql`
    ALTER TABLE backup_jobs ADD CONSTRAINT backup_jobs_hyperv_check
    CHECK (source_kind = 'files' or (hyperv_host_id is not null and hyperv_config is not null and location = 'agent'))
  `.execute(db);

  await sql`ALTER TABLE restore_runs DROP CONSTRAINT IF EXISTS restore_runs_mode_check`.execute(db);
  await sql`
    ALTER TABLE restore_runs ADD CONSTRAINT restore_runs_mode_check
    CHECK (mode in ('original','alternate_path','download','hyperv'))
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM restore_runs WHERE mode = 'hyperv'`.execute(db);
  await sql`ALTER TABLE restore_runs DROP CONSTRAINT IF EXISTS restore_runs_mode_check`.execute(db);
  await sql`
    ALTER TABLE restore_runs ADD CONSTRAINT restore_runs_mode_check
    CHECK (mode in ('original','alternate_path','download'))
  `.execute(db);

  // Hyper-V jobs have no file-based equivalent; they go with the feature.
  await sql`
    DELETE FROM job_runs WHERE job_id IN (SELECT id FROM backup_jobs WHERE source_kind = 'hyperv')
  `.execute(db);
  await sql`DELETE FROM backup_jobs WHERE source_kind = 'hyperv'`.execute(db);
  await sql`ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_hyperv_check`.execute(db);
  await db.schema
    .alterTable('backup_jobs')
    .dropColumn('hyperv_config')
    .dropColumn('hyperv_host_id')
    .dropColumn('source_kind')
    .execute();

  await db.schema.dropTable('hyperv_hosts').ifExists().execute();
  await sql`DELETE FROM secrets WHERE type = 'hyperv_credential'`.execute(db);
  await sql`ALTER TABLE secrets DROP CONSTRAINT IF EXISTS secrets_type_check`.execute(db);
  await sql`
    ALTER TABLE secrets
    ADD CONSTRAINT secrets_type_check
    CHECK (type in ('repo_password','backend_credential','notification_credential'))
  `.execute(db);
}
