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
/** Reachability of a target's backend endpoint (unknown = not probeable yet). */
export type TargetStatus = 'online' | 'offline' | 'unknown';
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
  /** Envelope-encrypted TOTP secret (Base32); null when 2FA is not configured. */
  totp_secret_ciphertext: string | null;
  totp_secret_nonce: string | null;
  totp_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  /** argon2 hashes of unused recovery codes; consumed on use. */
  totp_recovery_codes: JSONColumnType<string[] | null, string | null, string | null>;
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

// --- targets (= a shared backend connection) --------------------------------

export interface TargetsTable {
  id: Generated<string>;
  name: string;
  backend_type: string;
  /**
   * Connection-scoped, non-secret config (endpoint, host, region, user…). The
   * repository-specific parts (bucket, prefix, path) live per-job in
   * `backup_jobs.repo_config`, so one target can serve many repositories.
   */
  config: JSONColumnType<Record<string, unknown>>;
  /** Backend credential secret (access/secret keys, SSH key etc.), nullable. */
  credential_secret_id: string | null;
  owner_id: string;
  /** Reachability of the backend endpoint, maintained by TargetHealthService. */
  status: ColumnType<TargetStatus, TargetStatus | undefined, TargetStatus>;
  last_check_at: ColumnType<Date | null, Date | null, Date | null>;
  last_check_error: string | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type Target = Selectable<TargetsTable>;
export type NewTarget = Insertable<TargetsTable>;
export type TargetUpdate = Updateable<TargetsTable>;

// --- repositories (a job's restic repository) -------------------------------

export interface RepositoriesTable {
  id: Generated<string>;
  name: string;
  /** Shared connection this repository lives on; null ⇒ local filesystem repo. */
  target_id: string | null;
  /** Repository-specific, non-secret config (bucket, prefix, path). */
  repo_config: JSONColumnType<Record<string, unknown>>;
  /** restic repository password secret. */
  repo_password_secret_id: string;
  owner_id: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type Repository = Selectable<RepositoriesTable>;
export type NewRepository = Insertable<RepositoriesTable>;
export type RepositoryUpdate = Updateable<RepositoriesTable>;

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
  /**
   * Custom scripts run on the host that executes the job (the server for local
   * jobs, the Go agent for remote jobs). Each value is a path executed directly
   * (no shell, no arguments). `preScript` runs before the backup and gates it —
   * a non-zero exit aborts the run and marks it failed. `postSuccessScript` runs
   * after a successful backup, `postFailureScript` after a failed one (including
   * a failed pre-script); their exit code is logged but does not change the run
   * outcome. Scripts receive AMBER_* environment variables (job name/id, run id,
   * paths, and for the post scripts AMBER_STATUS / AMBER_SNAPSHOT_ID / AMBER_ERROR).
   */
  preScript?: string;
  postSuccessScript?: string;
  postFailureScript?: string;
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
  /** The repository this job backs up to (1:1, extracted from the old embedded columns). */
  repository_id: string;
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

/**
 * A backup job as read by the app: the job row joined with its repository's
 * resolution columns. Kept identical to the pre-extraction embedded shape so
 * job read/write code and the API stay unchanged.
 */
export type BackupJobRow = BackupJob &
  Pick<Repository, 'target_id' | 'repo_config' | 'repo_password_secret_id'>;

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
  // Live progress from restic --json "status" lines while a backup is running.
  bytesDone?: number;
  totalBytes?: number;
  filesDone?: number;
  totalFiles?: number;
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
  /** Connection the repository lives on; null ⇒ local filesystem repo. */
  target_id: string | null;
  /** Job whose repository is restored; null if the job was later deleted. */
  job_id: string | null;
  /** Repository-specific config, snapshotted from the job at create time. */
  repo_config: JSONColumnType<Record<string, unknown>>;
  /** Repository password secret, snapshotted from the job at create time. */
  repo_password_secret_id: string;
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

// --- reports ----------------------------------------------------------------

/** Relative time window a report aggregates over (resolved to a cutoff date). */
export type ReportWindow = '24h' | '7d' | '30d' | '90d' | '6mo' | '12mo';

/** Which runs a report summarizes: jobs, outcomes, and the look-back window. */
export interface ReportDataset {
  /** Jobs to include; empty means the report has nothing to report. */
  jobIds: string[];
  /** Run outcomes to count, e.g. ['success', 'failed']. */
  statuses: RunStatus[];
  window: ReportWindow;
}

export interface ReportsTable {
  id: Generated<string>;
  name: string;
  /** User-facing labels for grouping/filtering reports. */
  tags: JSONColumnType<string[]>;
  dataset: JSONColumnType<ReportDataset>;
  cron_expr: string;
  /** Notification channels the rendered report is delivered to. */
  channel_ids: JSONColumnType<string[]>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  last_run_at: ColumnType<Date | null, Date | null, Date | null>;
  owner_id: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type Report = Selectable<ReportsTable>;
export type NewReport = Insertable<ReportsTable>;
export type ReportUpdate = Updateable<ReportsTable>;

// --- webauthn_credentials ---------------------------------------------------

export interface WebauthnCredentialsTable {
  id: Generated<string>;
  user_id: string;
  /** Base64URL credential id returned by the authenticator (unique). */
  credential_id: string;
  /** Base64 of the COSE public key bytes. */
  public_key: string;
  /** Signature counter; pg returns bigint as a string. */
  counter: ColumnType<string, number | undefined, number>;
  transports: JSONColumnType<string[]>;
  device_type: string | null;
  backed_up: ColumnType<boolean, boolean | undefined, boolean>;
  /** User-facing device label. */
  name: string;
  created_at: CreatedAt;
  last_used_at: ColumnType<Date | null, Date | null, Date | null>;
}
export type WebauthnCredential = Selectable<WebauthnCredentialsTable>;
export type NewWebauthnCredential = Insertable<WebauthnCredentialsTable>;
export type WebauthnCredentialUpdate = Updateable<WebauthnCredentialsTable>;

// --- audit_log --------------------------------------------------------------

export type AuditOutcome = 'success' | 'failure';

/** Redacted, structured drill-down info shown when an audit row is opened. */
export interface AuditDetails {
  body?: Record<string, unknown>;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  error?: string;
  [k: string]: unknown;
}

export interface AuditLogTable {
  id: Generated<string>;
  created_at: CreatedAt;
  /** User id of the actor; null when unknown (e.g. failed login). */
  actor_id: string | null;
  actor_email: string | null;
  /** 'session' | 'apikey' | 'system'. */
  actor_type: string;
  actor_is_admin: ColumnType<boolean, boolean | undefined, boolean>;
  /** Human-readable summary, e.g. "Run job", "Delete target". */
  action: string;
  method: string | null;
  path: string | null;
  resource_type: string | null;
  resource_id: string | null;
  status_code: number | null;
  outcome: ColumnType<AuditOutcome, AuditOutcome | undefined, AuditOutcome>;
  ip: string | null;
  user_agent: string | null;
  details: JSONColumnType<AuditDetails | null, string | null, string | null>;
}
export type AuditLog = Selectable<AuditLogTable>;
export type NewAuditLog = Insertable<AuditLogTable>;

// --- Root DB interface ------------------------------------------------------

export interface Database {
  users: UsersTable;
  api_keys: ApiKeysTable;
  resource_grants: ResourceGrantsTable;
  secrets: SecretsTable;
  targets: TargetsTable;
  repositories: RepositoriesTable;
  agents: AgentsTable;
  enrollment_tokens: EnrollmentTokensTable;
  app_settings: AppSettingsTable;
  backup_jobs: BackupJobsTable;
  job_runs: JobRunsTable;
  restore_runs: RestoreRunsTable;
  notification_channels: NotificationChannelsTable;
  reports: ReportsTable;
  webauthn_credentials: WebauthnCredentialsTable;
  audit_log: AuditLogTable;
}
