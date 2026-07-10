import { Kysely, sql } from 'kysely';

/**
 * Initial schema — all tables from the design concept (§5).
 * Uses gen_random_uuid() (pgcrypto/pg13+) for primary keys.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);

  // --- users ---
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('display_name', 'text', (c) => c.notNull())
    .addColumn('auth_source', 'text', (c) =>
      c.notNull().check(sql`auth_source in ('local','oidc','entra')`),
    )
    .addColumn('password_hash', 'text')
    .addColumn('is_admin', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('disabled', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // --- secrets ---
  await db.schema
    .createTable('secrets')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('type', 'text', (c) =>
      c.notNull().check(sql`type in ('repo_password','backend_credential')`),
    )
    .addColumn('ciphertext', 'text', (c) => c.notNull())
    .addColumn('nonce', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // --- api_keys ---
  await db.schema
    .createTable('api_keys')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('key_hash', 'text', (c) => c.notNull())
    .addColumn('prefix', 'text', (c) => c.notNull())
    .addColumn('scopes', 'jsonb', (c) => c.notNull().defaultTo(sql`'{"actions":["*"]}'::jsonb`))
    .addColumn('expires_at', 'timestamptz')
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('api_keys_prefix_idx').on('api_keys').column('prefix').execute();

  // --- resource_grants ---
  await db.schema
    .createTable('resource_grants')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('resource_type', 'text', (c) =>
      c.notNull().check(sql`resource_type in ('target','source','job')`),
    )
    .addColumn('resource_id', 'uuid', (c) => c.notNull())
    .addColumn('access_level', 'text', (c) =>
      c.notNull().check(sql`access_level in ('view','operate','manage')`),
    )
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('resource_grants_unique', [
      'user_id',
      'resource_type',
      'resource_id',
    ])
    .execute();
  await db.schema
    .createIndex('resource_grants_user_idx')
    .on('resource_grants')
    .column('user_id')
    .execute();

  // --- targets ---
  await db.schema
    .createTable('targets')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('backend_type', 'text', (c) => c.notNull())
    .addColumn('config', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('password_secret_id', 'uuid', (c) => c.notNull().references('secrets.id'))
    .addColumn('credential_secret_id', 'uuid', (c) => c.references('secrets.id'))
    .addColumn('owner_id', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // --- agents ---
  await db.schema
    .createTable('agents')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('hostname', 'text')
    .addColumn('os', 'text')
    .addColumn('deploy_method', 'text', (c) =>
      c.check(sql`deploy_method in ('binary','docker')`),
    )
    .addColumn('status', 'text', (c) =>
      c
        .notNull()
        .defaultTo('enrolled')
        .check(sql`status in ('enrolled','online','offline','error')`),
    )
    .addColumn('last_seen_at', 'timestamptz')
    .addColumn('agent_key_hash', 'text', (c) => c.notNull())
    .addColumn('agent_pubkey', 'text')
    .addColumn('server_privkey', 'text')
    .addColumn('agent_version', 'text')
    .addColumn('restic_version', 'text')
    .addColumn('poll_interval_seconds', 'integer', (c) => c.notNull().defaultTo(30))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // --- enrollment_tokens ---
  await db.schema
    .createTable('enrollment_tokens')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('token_hash', 'text', (c) => c.notNull())
    .addColumn('intended_agent_name', 'text')
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('used_at', 'timestamptz')
    .addColumn('created_by', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // --- sources ---
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
    .execute();

  // --- backup_jobs ---
  await db.schema
    .createTable('backup_jobs')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('source_id', 'uuid', (c) =>
      c.notNull().references('sources.id').onDelete('cascade'),
    )
    .addColumn('target_id', 'uuid', (c) =>
      c.notNull().references('targets.id').onDelete('cascade'),
    )
    .addColumn('cron_expr', 'text', (c) => c.notNull())
    .addColumn('restic_options', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('enabled', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('owner_id', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // --- job_runs ---
  await db.schema
    .createTable('job_runs')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('job_id', 'uuid', (c) =>
      c.notNull().references('backup_jobs.id').onDelete('cascade'),
    )
    .addColumn('trigger', 'text', (c) =>
      c.notNull().check(sql`trigger in ('schedule','manual')`),
    )
    .addColumn('status', 'text', (c) =>
      c
        .notNull()
        .defaultTo('queued')
        .check(sql`status in ('queued','running','success','failed','cancelled')`),
    )
    .addColumn('agent_id', 'uuid', (c) => c.references('agents.id').onDelete('set null'))
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('snapshot_id', 'text')
    .addColumn('stats', 'jsonb')
    .addColumn('forget_result', 'jsonb')
    .addColumn('log', 'text')
    .addColumn('error', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('job_runs_job_idx').on('job_runs').column('job_id').execute();
  await db.schema.createIndex('job_runs_status_idx').on('job_runs').column('status').execute();

  // --- restore_runs ---
  await db.schema
    .createTable('restore_runs')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('target_id', 'uuid', (c) =>
      c.notNull().references('targets.id').onDelete('cascade'),
    )
    .addColumn('snapshot_id', 'text', (c) => c.notNull())
    .addColumn('included_paths', 'jsonb')
    .addColumn('mode', 'text', (c) =>
      c.notNull().check(sql`mode in ('original','alternate_path','download')`),
    )
    .addColumn('destination', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('options', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('status', 'text', (c) =>
      c
        .notNull()
        .defaultTo('queued')
        .check(sql`status in ('queued','running','success','failed','cancelled')`),
    )
    .addColumn('agent_id', 'uuid', (c) => c.references('agents.id').onDelete('set null'))
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('stats', 'jsonb')
    .addColumn('download_expires_at', 'timestamptz')
    .addColumn('log', 'text')
    .addColumn('error', 'text')
    .addColumn('initiated_by', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex('restore_runs_status_idx')
    .on('restore_runs')
    .column('status')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of [
    'restore_runs',
    'job_runs',
    'backup_jobs',
    'sources',
    'enrollment_tokens',
    'agents',
    'targets',
    'resource_grants',
    'api_keys',
    'secrets',
    'users',
  ]) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}
