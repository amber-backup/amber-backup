import {
  ColumnType,
  Generated,
  Insertable,
  JSONColumnType,
  Selectable,
  Updateable,
} from 'kysely';

/**
 * Kysely database schema. Mirrors the migrations in `src/database/migrations`.
 * Column-level docs live in the design concept (§5).
 */

// Common column helpers ------------------------------------------------------

/** Timestamp that is set by the DB on insert and never sent by the app. */
type CreatedAt = ColumnType<Date, never, never>;
/** Timestamp maintained by the app on update. */
type UpdatedAt = ColumnType<Date, Date | undefined, Date>;

// Enums (kept as string unions; enforced in DB via CHECK constraints) --------

export type AuthSource = 'local' | 'oidc' | 'entra';
export type ResourceType = 'target' | 'source' | 'job';
export type AccessLevel = 'view' | 'operate' | 'manage';
export type DeployMethod = 'binary' | 'docker';
export type AgentStatus = 'enrolled' | 'online' | 'offline' | 'error';
export type SourceLocation = 'local' | 'agent';
export type RunTrigger = 'schedule' | 'manual';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled';
export type RestoreMode = 'original' | 'alternate_path' | 'download';
export type SecretType =
  | 'repo_password'
  | 'backend_credential'
  | 'notification_credential';
export type TaskType = 'backup' | 'restore' | 'snapshots' | 'ls' | 'check';

// --- users ------------------------------------------------------------------

export interface UsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  auth_source: AuthSource;
  password_hash: string | null;
  is_admin: ColumnType<boolean, boolean | undefined, boolean>;
  disabled: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

// --- api_keys ---------------------------------------------------------------

export interface ApiKeyScopes {
  /** Allowed action verbs, e.g. ['read','backup','restore']. '*' = all. */
  actions: string[];
  /** Optional resource restriction; omitted = all the user can access. */
  resources?: { type: ResourceType; id: string }[];
}

export interface ApiKeysTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  key_hash: string;
  prefix: string;
  scopes: JSONColumnType<ApiKeyScopes>;
  expires_at: ColumnType<Date | null, Date | null, Date | null>;
  last_used_at: ColumnType<Date | null, never, Date | null>;
  created_at: CreatedAt;
}
export type ApiKey = Selectable<ApiKeysTable>;
export type NewApiKey = Insertable<ApiKeysTable>;
export type ApiKeyUpdate = Updateable<ApiKeysTable>;

// --- resource_grants --------------------------------------------------------

export interface ResourceGrantsTable {
  id: Generated<string>;
  user_id: string;
  resource_type: ResourceType;
  resource_id: string;
  access_level: AccessLevel;
  created_at: CreatedAt;
}
export type ResourceGrant = Selectable<ResourceGrantsTable>;
export type NewResourceGrant = Insertable<ResourceGrantsTable>;

// --- secrets ----------------------------------------------------------------

export interface SecretsTable {
  id: Generated<string>;
  type: SecretType;
  ciphertext: string;
  nonce: string;
  created_at: CreatedAt;
}
export type Secret = Selectable<SecretsTable>;
export type NewSecret = Insertable<SecretsTable>;

// --- targets (= one restic repository) --------------------------------------

export interface TargetsTable {
  id: Generated<string>;
  name: string;
  backend_type: string;
  /** Backend-specific, non-secret config (bucket, endpoint, path, region…). */
  config: JSONColumnType<Record<string, unknown>>;
  /** Repo password secret. */
  password_secret_id: string;
  /** Backend credential secret (access/secret keys etc.), nullable. */
  credential_secret_id: string | null;
  owner_id: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type Target = Selectable<TargetsTable>;
export type NewTarget = Insertable<TargetsTable>;
export type TargetUpdate = Updateable<TargetsTable>;

// --- agents -----------------------------------------------------------------

export interface AgentsTable {
  id: Generated<string>;
  name: string;
  hostname: string | null;
  os: string | null;
  deploy_method: DeployMethod | null;
  status: ColumnType<AgentStatus, AgentStatus | undefined, AgentStatus>;
  last_seen_at: ColumnType<Date | null, Date | null, Date | null>;
  agent_key_hash: string;
  agent_pubkey: string | null;
  server_privkey: string | null;
  agent_version: string | null;
  restic_version: string | null;
  poll_interval_seconds: ColumnType<number, number | undefined, number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type Agent = Selectable<AgentsTable>;
export type NewAgent = Insertable<AgentsTable>;
export type AgentUpdate = Updateable<AgentsTable>;

// --- enrollment_tokens ------------------------------------------------------

export interface EnrollmentTokensTable {
  id: Generated<string>;
  token_hash: string;
  intended_agent_name: string | null;
  expires_at: ColumnType<Date, Date, Date>;
  used_at: ColumnType<Date | null, Date | null, Date | null>;
  created_by: string;
  created_at: CreatedAt;
}
export type EnrollmentToken = Selectable<EnrollmentTokensTable>;
export type NewEnrollmentToken = Insertable<EnrollmentTokensTable>;

// --- app_settings -----------------------------------------------------------

export interface AppSettingsTable {
  key: string;
  value: ColumnType<unknown, string, string>;
  updated_at: Generated<Date>;
}

/** Stored (encrypted) value of the `global_enrollment` setting. */
export interface GlobalEnrollmentValue {
  enabled: boolean;
  /** Encrypted global token; null when never generated. */
  ciphertext: string | null;
  nonce: string | null;
}

// --- backup_jobs ------------------------------------------------------------

export interface ResticOptions {
  tags?: string[];
  exclude?: string[];
  iexclude?: string[];
  excludeFile?: string[];
  oneFileSystem?: boolean;
  excludeCaches?: boolean;
  excludeLargerThan?: string;
  compression?: 'auto' | 'max' | 'off';
  readConcurrency?: number;
  retention?: {
    keepLast?: number;
    keepHourly?: number;
    keepDaily?: number;
    keepWeekly?: number;
    keepMonthly?: number;
    keepYearly?: number;
    keepWithin?: string;
    keepTags?: string[];
    prune?: boolean;
  };
  preHook?: string;
  postHook?: string;
  timeLimitSeconds?: number;
}

/** Which notification channels a job fires, and on which outcomes. */
export interface JobNotifyConfig {
  channelIds?: string[];
  onSuccess?: boolean;
  onFailure?: boolean;
}

export interface BackupJobsTable {
  id: Generated<string>;
  name: string;
  /** Where the data lives (embedded, formerly the sources table). */
  location: SourceLocation;
  agent_id: string | null;
  paths: JSONColumnType<string[]>;
  target_id: string;
  cron_expr: string;
  restic_options: JSONColumnType<ResticOptions>;
  notify: JSONColumnType<JobNotifyConfig>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  owner_id: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type BackupJob = Selectable<BackupJobsTable>;
export type NewBackupJob = Insertable<BackupJobsTable>;
export type BackupJobUpdate = Updateable<BackupJobsTable>;

// --- job_runs ---------------------------------------------------------------

export interface RunStats {
  filesNew?: number;
  filesChanged?: number;
  filesUnmodified?: number;
  dirsNew?: number;
  dataAdded?: number;
  totalBytesProcessed?: number;
  totalFilesProcessed?: number;
  totalDuration?: number;
  percentDone?: number;
}

export interface JobRunsTable {
  id: Generated<string>;
  job_id: string;
  trigger: RunTrigger;
  status: ColumnType<RunStatus, RunStatus | undefined, RunStatus>;
  /** Set when dispatched to an agent; null for local runs. */
  agent_id: string | null;
  started_at: ColumnType<Date | null, Date | null, Date | null>;
  finished_at: ColumnType<Date | null, Date | null, Date | null>;
  snapshot_id: string | null;
  stats: JSONColumnType<RunStats | null, string | null, string | null>;
  forget_result: JSONColumnType<
    Record<string, unknown> | null,
    string | null,
    string | null
  >;
  log: string | null;
  error: string | null;
  created_at: CreatedAt;
}
export type JobRun = Selectable<JobRunsTable>;
export type NewJobRun = Insertable<JobRunsTable>;
export type JobRunUpdate = Updateable<JobRunsTable>;

// --- restore_runs -----------------------------------------------------------

export interface RestoreOptions {
  overwrite?: 'always' | 'if-changed' | 'if-newer' | 'never';
  verify?: boolean;
  delete?: boolean;
  dryRun?: boolean;
  include?: string[];
  exclude?: string[];
}

export interface RestoreDestination {
  /** For alternate_path / original: filesystem path. */
  path?: string;
  /** When restoring onto an agent host. */
  agentId?: string;
  /** For download mode: server-side artifact reference. */
  downloadRef?: string;
}

export interface RestoreRunsTable {
  id: Generated<string>;
  target_id: string;
  snapshot_id: string;
  included_paths: JSONColumnType<string[] | null, string | null, string | null>;
  mode: RestoreMode;
  destination: JSONColumnType<RestoreDestination>;
  options: JSONColumnType<RestoreOptions>;
  status: ColumnType<RunStatus, RunStatus | undefined, RunStatus>;
  agent_id: string | null;
  started_at: ColumnType<Date | null, Date | null, Date | null>;
  finished_at: ColumnType<Date | null, Date | null, Date | null>;
  stats: JSONColumnType<RunStats | null, string | null, string | null>;
  download_expires_at: ColumnType<Date | null, Date | null, Date | null>;
  log: string | null;
  error: string | null;
  initiated_by: string;
  created_at: CreatedAt;
}
export type RestoreRun = Selectable<RestoreRunsTable>;
export type NewRestoreRun = Insertable<RestoreRunsTable>;
export type RestoreRunUpdate = Updateable<RestoreRunsTable>;

// --- notification_channels --------------------------------------------------

export interface NotificationChannelsTable {
  id: Generated<string>;
  name: string;
  type: string;
  /** Non-secret provider config (host, chat id, from address…). */
  config: JSONColumnType<Record<string, unknown>>;
  /** Encrypted provider secrets (tokens, webhook URLs, passwords), nullable. */
  secret_id: string | null;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  owner_id: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type NotificationChannel = Selectable<NotificationChannelsTable>;
export type NewNotificationChannel = Insertable<NotificationChannelsTable>;
export type NotificationChannelUpdate = Updateable<NotificationChannelsTable>;

// --- Root DB interface ------------------------------------------------------

export interface Database {
  users: UsersTable;
  api_keys: ApiKeysTable;
  resource_grants: ResourceGrantsTable;
  secrets: SecretsTable;
  targets: TargetsTable;
  agents: AgentsTable;
  enrollment_tokens: EnrollmentTokensTable;
  app_settings: AppSettingsTable;
  backup_jobs: BackupJobsTable;
  job_runs: JobRunsTable;
  restore_runs: RestoreRunsTable;
  notification_channels: NotificationChannelsTable;
}
