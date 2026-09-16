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

/**
 * How an account authenticates. 'sso' is the generic value for accounts that
 * sign in through an identity provider; 'oidc' and 'entra' predate it and mean
 * the same thing (the SSO callback never recorded the provider).
 */
export type AuthSource = 'local' | 'oidc' | 'entra' | 'sso';

export const USER_LOCALES = ['en', 'de'] as const;
export type UserLocale = (typeof USER_LOCALES)[number];
export type ResourceType = 'target' | 'source' | 'job';
export type AccessLevel = 'view' | 'operate' | 'manage';
export type DeployMethod = 'binary' | 'docker';
export type AgentStatus = 'enrolled' | 'online' | 'offline' | 'error';
/** Reachability of a target's backend endpoint (unknown = not probeable yet). */
export type TargetStatus = 'online' | 'offline' | 'unknown';
export type SourceLocation = 'local' | 'agent';
export type RunTrigger = 'schedule' | 'manual';
/**
 * What a job_runs row records: a backup, a `restic prune` or a `restic check`
 * of the job's repository.
 */
export type RunKind = 'backup' | 'prune' | 'check';
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
/**
 * How much of a repository an integrity check verifies: 'quick' checks the
 * structure only (`restic check`), 'rotating' also reads one part of the pack
 * data per run (`--read-data-subset=n/parts`), 'full' reads all of it.
 */
export type IntegrityLevel = 'quick' | 'rotating' | 'full';
/** Verdict of the last integrity check that finished. */
export type CheckStatus = 'passed' | 'damaged';

// --- users ------------------------------------------------------------------

export interface UsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  auth_source: AuthSource;
  password_hash: string | null;
  is_admin: ColumnType<boolean, boolean | undefined, boolean>;
  disabled: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * Monotonic session generation. Embedded in each session JWT and checked per
   * request; bumping it (on password change/reset) revokes all live sessions.
   */
  session_epoch: ColumnType<number, number | undefined, number>;
  /** Envelope-encrypted TOTP secret (Base32); null when 2FA is not configured. */
  totp_secret_ciphertext: string | null;
  totp_secret_nonce: string | null;
  totp_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  /** argon2 hashes of unused recovery codes; consumed on use. */
  totp_recovery_codes: JSONColumnType<string[] | null, string | null, string | null>;
  /** Preferred UI language; null follows the browser. */
  locale: UserLocale | null;
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

// --- device_authorizations --------------------------------------------------

export type DeviceAuthorizationStatus = 'pending' | 'approved' | 'denied' | 'consumed';
export type DeviceAccess = 'full' | 'read';

export interface DeviceAuthorizationsTable {
  id: Generated<string>;
  device_code_hash: string;
  user_code_hash: string;
  client_name: string;
  request_ip: string | null;
  request_user_agent: string | null;
  status: ColumnType<
    DeviceAuthorizationStatus,
    DeviceAuthorizationStatus | undefined,
    DeviceAuthorizationStatus
  >;
  user_id: string | null;
  access: DeviceAccess | null;
  key_expires_in_days: number | null;
  api_key_id: string | null;
  expires_at: ColumnType<Date, Date, Date>;
  last_polled_at: ColumnType<Date | null, Date | null, Date | null>;
  decided_at: ColumnType<Date | null, Date | null, Date | null>;
  created_at: CreatedAt;
}
export type DeviceAuthorization = Selectable<DeviceAuthorizationsTable>;

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
  /** Name-derived, unique, kebab-case identifier; maintained by the app. */
  slug: string;
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
  /** Name-derived, unique, kebab-case identifier; maintained by the app. */
  slug: string;
  /** Shared connection this repository lives on; null ⇒ local filesystem repo. */
  target_id: string | null;
  /** Repository-specific, non-secret config (bucket, prefix, path). */
  repo_config: JSONColumnType<Record<string, unknown>>;
  /** restic repository password secret. */
  repo_password_secret_id: string;
  /**
   * Per-repository override of the connection's overridable credentials (see
   * `backend-registry`), encrypted; null ⇒ the connection's own credentials.
   */
  credential_secret_id: string | null;
  owner_id: string;
  /**
   * Cached figures from `restic stats` / `restic snapshots`, refreshed after
   * each successful backup run and on demand (RepositoriesService).
   * `size_bytes` is a bigint; pg returns it as a string.
   */
  size_bytes: ColumnType<string | null, number | null, number | null>;
  snapshot_count: number | null;
  /** When the figures were last read successfully. */
  stats_at: ColumnType<Date | null, Date | null, Date | null>;
  /** Last refresh failure (figures then reflect the previous read), if any. */
  stats_error: string | null;
  /** Verdict of the last integrity check that finished; null ⇒ never checked. */
  check_status: CheckStatus | null;
  /** When that verdict was reached. */
  check_at: ColumnType<Date | null, Date | null, Date | null>;
  /** Level of that check. */
  check_level: IntegrityLevel | null;
  /** Why the most recent check could not finish; cleared by the next verdict. */
  check_error: string | null;
  /** When all pack data was last read back successfully (full check or completed rotation). */
  data_verified_at: ColumnType<Date | null, Date | null, Date | null>;
  /** Part a rotating check reads next (1-based). */
  check_subset_next: ColumnType<number, number | undefined, number>;
  /** Number of parts the rotation in progress splits the data into. */
  check_subset_parts: number | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type Repository = Selectable<RepositoriesTable>;
export type NewRepository = Insertable<RepositoriesTable>;
export type RepositoryUpdate = Updateable<RepositoriesTable>;

/** One reading of a repository's figures; appended whenever they change. */
export interface RepositoryStatsHistoryTable {
  id: Generated<string>;
  repository_id: string;
  measured_at: ColumnType<Date, Date | undefined, never>;
  /** bigint — pg returns it as a string. */
  size_bytes: ColumnType<string, number, never>;
  snapshot_count: number;
}
export type RepositoryStatsHistory = Selectable<RepositoryStatsHistoryTable>;

// --- agents -----------------------------------------------------------------

export interface AgentsTable {
  id: Generated<string>;
  name: string;
  /** Name-derived, unique, kebab-case identifier; maintained by the app. */
  slug: string;
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
  /** Free-form admin labels for grouping agents. */
  labels: JSONColumnType<string[], string | undefined, string>;
  /** IPs/CIDR ranges the agent's authenticated requests must come from; empty = any. */
  allowed_ips: JSONColumnType<string[], string | undefined, string>;
  /** Source address of the agent's latest poll. */
  last_ip: ColumnType<string | null, string | null | undefined, string | null>;
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

/** A job's integrity check schedule (`backup_jobs.integrity_check`). */
export interface IntegrityCheckConfig {
  enabled?: boolean;
  cronExpr?: string;
  level?: IntegrityLevel;
  /** For 'rotating': how many parts the data is split into (one per run). */
  subsetParts?: number;
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
  /** Name-derived, unique, kebab-case identifier; maintained by the app. */
  slug: string;
  /** Where the data lives (embedded, formerly the sources table). */
  location: SourceLocation;
  agent_id: string | null;
  paths: JSONColumnType<string[]>;
  /** The repository this job backs up to (1:1, extracted from the old embedded columns). */
  repository_id: string;
  cron_expr: string;
  restic_options: JSONColumnType<ResticOptions>;
  notify: JSONColumnType<JobNotifyConfig>;
  integrity_check: ColumnType<IntegrityCheckConfig, string | undefined, string>;
  /** How often a failed backup is retried (0 = never). */
  retry_max: ColumnType<number, number | undefined, number>;
  /** Wait before each retry, in seconds. */
  retry_delay_seconds: ColumnType<number, number | undefined, number>;
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
  Pick<
    Repository,
    | 'target_id'
    | 'repo_config'
    | 'repo_password_secret_id'
    | 'credential_secret_id'
  > & {
    /** Cached repository figures (see RepositoriesTable), prefixed to avoid clashes. */
    repo_size_bytes: string | null;
    repo_snapshot_count: number | null;
    repo_stats_at: Date | null;
    repo_stats_error: string | null;
    /** Integrity check state of the repository (see RepositoriesTable). */
    repo_check_status: CheckStatus | null;
    repo_check_at: Date | null;
    repo_check_level: IntegrityLevel | null;
    repo_check_error: string | null;
    repo_data_verified_at: Date | null;
    repo_check_subset_next: number;
    repo_check_subset_parts: number | null;
  };

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

/** What an integrity check run verified (`job_runs.check_info`). */
export interface CheckInfo {
  level: IntegrityLevel;
  /** For a rotating check: the part of the data read by this run. */
  part?: number;
  parts?: number;
  /** Set once finished: true when restic reported repository errors. */
  damaged?: boolean;
}

export interface JobRunsTable {
  id: Generated<string>;
  job_id: string;
  kind: ColumnType<RunKind, RunKind | undefined, RunKind>;
  /** For a prune started by a backup's retention: that backup run. */
  parent_run_id: string | null;
  /** For a check: what it verified and whether it found damage. */
  check_info: ColumnType<CheckInfo | null, string | null | undefined, string | null>;
  trigger: RunTrigger;
  status: ColumnType<RunStatus, RunStatus | undefined, RunStatus>;
  /** 1 for the first try of a backup; a retry counts on from its predecessor. */
  attempt: ColumnType<number, number | undefined, number>;
  /** For a retry: the failed run it repeats. */
  retry_of_run_id: string | null;
  /** A queued retry does not start before this time. */
  not_before: ColumnType<Date | null, Date | null | undefined, Date | null>;
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
  /** Credential override secret, snapshotted from the job at create time. */
  credential_secret_id: string | null;
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
  /** Name-derived, unique, kebab-case identifier; maintained by the app. */
  slug: string;
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
  /** Name-derived, unique, kebab-case identifier; maintained by the app. */
  slug: string;
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

// --- sso_identities ---------------------------------------------------------

/** The identity an SSO provider asserted for a user, bound by its subject id. */
export interface SsoIdentitiesTable {
  id: Generated<string>;
  user_id: string;
  /** Id of the provider entry in the SSO settings. */
  provider_id: string;
  /** Immutable subject claim (`sub`; GitHub's numeric user id). */
  subject: string;
  created_at: CreatedAt;
  last_login_at: ColumnType<Date | null, Date | null, Date | null>;
}
export type SsoIdentity = Selectable<SsoIdentitiesTable>;

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
  device_authorizations: DeviceAuthorizationsTable;
  resource_grants: ResourceGrantsTable;
  secrets: SecretsTable;
  targets: TargetsTable;
  repositories: RepositoriesTable;
  repository_stats_history: RepositoryStatsHistoryTable;
  agents: AgentsTable;
  enrollment_tokens: EnrollmentTokensTable;
  app_settings: AppSettingsTable;
  backup_jobs: BackupJobsTable;
  job_runs: JobRunsTable;
  restore_runs: RestoreRunsTable;
  notification_channels: NotificationChannelsTable;
  reports: ReportsTable;
  webauthn_credentials: WebauthnCredentialsTable;
  sso_identities: SsoIdentitiesTable;
  audit_log: AuditLogTable;
}
