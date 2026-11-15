// Typed fetch wrapper around the Amber REST API. Session auth is cookie-based.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      message = Array.isArray(data.message)
        ? data.message.join(', ')
        : (data.message ?? message);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// --- Domain types (mirror server DTOs) ---

export interface User {
  id: string;
  email: string;
  display_name: string;
  auth_source: string;
  is_admin: boolean;
  disabled: boolean;
  totp_enabled: boolean;
  /** Preferred UI language; null follows the browser. */
  locale: 'en' | 'de' | null;
}

/** Newest published release as last seen by the server's update check. */
export interface UpdateStatus {
  latestVersion: string | null;
  releaseUrl: string | null;
  checkedAt: string | null;
}

export interface Target {
  id: string;
  name: string;
  /** Name-derived, unique, kebab-case identifier; maintained by the server. */
  slug: string;
  backend_type: string;
  config: Record<string, unknown>;
  owner_id: string;
  /** Reachability of the backend endpoint, maintained by the server. */
  status: 'online' | 'offline' | 'unknown';
  last_check_at: string | null;
  last_check_error: string | null;
}

export interface BackendField {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  secret?: boolean;
  /** 'job' fields configure the per-job repository; others the connection. */
  scope?: 'target' | 'job';
  /** Connection credential a single job may override with its own value. */
  overridable?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}
export interface BackendDef {
  type: string;
  label: string;
  fields: BackendField[];
}

export interface JobNotify {
  channelIds?: string[];
  onSuccess?: boolean;
  onFailure?: boolean;
}

/**
 * How much of a repository an integrity check verifies: 'quick' checks the
 * structure only, 'rotating' also reads the next part of the data, 'full'
 * reads all of it.
 */
export type IntegrityLevel = 'quick' | 'rotating' | 'full';

/** A job's integrity check schedule. */
export interface IntegrityCheckConfig {
  enabled?: boolean;
  cronExpr?: string;
  level?: IntegrityLevel;
  /** For 'rotating': number of parts the data is split into, one per run. */
  subsetParts?: number;
}

/** What a check run verified and, once finished, whether it found damage. */
export interface CheckInfo {
  level: IntegrityLevel;
  part?: number;
  parts?: number;
  damaged?: boolean;
}

export interface Job {
  id: string;
  name: string;
  /** Name-derived, unique, kebab-case identifier; maintained by the server. */
  slug: string;
  location: 'local' | 'agent';
  agent_id: string | null;
  paths: string[];
  /**
   * files: host paths; hyperv: VMs of a Hyper-V host (runs on its agent);
   * proxmox: guests of a Proxmox VE cluster (runs on the node agents).
   */
  source_kind?: 'files' | 'hyperv' | 'proxmox';
  hyperv_host_id?: string | null;
  hyperv_config?: HypervJobConfig | null;
  proxmox_cluster_id?: string | null;
  proxmox_config?: ProxmoxJobConfig | null;
  /** Shared connection the repository lives on; null ⇒ local filesystem repo. */
  target_id: string | null;
  /** Repository-specific fields (bucket, prefix, path). */
  repo_config?: Record<string, unknown>;
  /** True when the job overrides the connection's credentials (values stay secret). */
  has_credential_override?: boolean;
  /** The (1:1) repository this job backs up to. */
  repository_id: string;
  /** Cached repository figures; refreshed after each successful run and on demand. */
  repo_size_bytes?: number | null;
  repo_snapshot_count?: number | null;
  /** When the figures were last read successfully. */
  repo_stats_at?: string | null;
  /** Last refresh failure (figures then reflect the previous read), if any. */
  repo_stats_error?: string | null;
  /** Why the job's schedule cannot run (the scheduler rejects its cron); null when fine. */
  schedule_error?: string | null;
  /** Same for the integrity check's schedule. */
  check_schedule_error?: string | null;
  /** Verdict of the repository's last finished integrity check; null ⇒ never checked. */
  repo_check_status?: 'passed' | 'damaged' | null;
  repo_check_at?: string | null;
  repo_check_level?: IntegrityLevel | null;
  /** Why the most recent check could not finish; cleared by the next verdict. */
  repo_check_error?: string | null;
  /** When all data was last read back (full check or completed rotation). */
  repo_data_verified_at?: string | null;
  /** Part the next rotating check reads, of `repo_check_subset_parts`. */
  repo_check_subset_next?: number;
  repo_check_subset_parts?: number | null;
  integrity_check?: IntegrityCheckConfig;
  /** Next scheduled integrity check, if a schedule is on. */
  next_check?: string | null;
  cron_expr: string;
  restic_options: Record<string, unknown>;
  notify?: JobNotify;
  /** How often a failed backup is retried (0 = never). */
  retry_max?: number;
  /** Wait before each retry, in seconds. */
  retry_delay_seconds?: number;
  enabled: boolean;
  next_run?: string | null;
  /** Latest finished backup run; null ⇒ the job has not finished one yet. */
  last_run?: JobLastRun | null;
}

/** A job's latest finished backup, as listed with the job. */
export interface JobLastRun {
  id: string;
  status: 'success' | 'failed' | 'cancelled';
  started_at: string | null;
  finished_at: string;
  error: string | null;
}

/** Result of POST /repositories/:id/stats. */
export interface RepositoryStats {
  size_bytes: number | null;
  snapshot_count: number | null;
  stats_at: string | null;
  stats_error: string | null;
}

/**
 * Result of POST /repositories/:id/stats. `queued`: the job runs on an agent,
 * which reads the figures after its next poll; these are the cached ones.
 */
export interface RepositoryStatsRefresh extends RepositoryStats {
  queued: boolean;
}

/** Result of GET /repositories/stats-history?days=N (dashboard growth chart). */
export interface RepositoryStatsHistory {
  since: string;
  repositories: { id: string; name: string }[];
  /** Readings inside the window plus, per repository, the last one before it. */
  points: { repository_id: string; measured_at: string; size_bytes: number }[];
}

export interface NotificationChannel {
  id: string;
  name: string;
  /** Name-derived, unique, kebab-case identifier; maintained by the server. */
  slug: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface ChannelDef {
  type: string;
  label: string;
  fields: BackendField[];
}

export interface ReportDataset {
  jobIds: string[];
  statuses: ('success' | 'failed')[];
  window: '24h' | '7d' | '30d' | '90d' | '6mo' | '12mo';
}

export interface Report {
  id: string;
  name: string;
  /** Name-derived, unique, kebab-case identifier; maintained by the server. */
  slug: string;
  tags: string[];
  dataset: ReportDataset;
  cron_expr: string;
  channel_ids: string[];
  enabled: boolean;
  last_run_at: string | null;
  next_run?: string | null;
}

export interface Run {
  id: string;
  /** Null only for a restore whose job was deleted since. */
  job_id: string | null;
  job_name?: string | null;
  /**
   * A backup, a `restic prune` / `restic check` of the job's repository, or a
   * restore from it (a `restore_runs` row in the activity feed).
   */
  kind: 'backup' | 'prune' | 'check' | 'restore';
  /** For a restore: where it writes (`original`, `alternate_path`, `download`). */
  restore_mode?: string | null;
  /** For a prune started by a backup's retention: that backup run. */
  parent_run_id: string | null;
  /** For a check: what it verified and whether it found damage. */
  check_info?: CheckInfo | null;
  trigger: string;
  status: string;
  /** 1 for the first try of a backup; a retry counts on from the run it repeats. */
  attempt?: number;
  /** For a retry: the failed run it repeats. */
  retry_of_run_id?: string | null;
  /** A queued retry does not start before this time. */
  not_before?: string | null;
  agent_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  snapshot_id: string | null;
  stats: Record<string, unknown> | null;
  error: string | null;
  /** Output of the run; only `GET /runs/:id` and `GET /restores/:id` return it. */
  log?: string | null;
  created_at: string;
}

export interface Agent {
  id: string;
  name: string;
  /** Name-derived, unique, kebab-case identifier; maintained by the server. */
  slug: string;
  hostname: string | null;
  os: string | null;
  status: string;
  last_seen_at: string | null;
  agent_version: string | null;
  restic_version: string | null;
  poll_interval_seconds: number;
  /** Free-form admin labels. */
  labels: string[];
  /** IPs/CIDR ranges the agent may connect from; empty = any address. */
  allowed_ips: string[];
  /** Source address of the agent's latest poll. */
  last_ip: string | null;
}

/** Whether an agent runs on Windows, judged by the OS it reports. */
export function isWindowsAgent(agent?: Pick<Agent, 'os'> | null): boolean {
  return !!agent?.os && /^windows/i.test(agent.os);
}

export interface Snapshot {
  id: string;
  short_id: string;
  time: string;
  hostname: string;
  tags?: string[];
  paths: string[];
}

export interface LsEntry {
  name: string;
  type: string;
  path: string;
  size?: number;
  mtime?: string;
}

export interface RestoreRun {
  id: string;
  job_id: string | null;
  snapshot_id: string;
  mode: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  download_expires_at: string | null;
  error: string | null;
  created_at: string;
}

// --- Hyper-V ------------------------------------------------------------------

export interface HypervJobConfig {
  allVms: boolean;
  vmIds: string[];
  excludeVmIds?: string[];
  checkpointMode?: 'Production' | 'ProductionOnly';
  parallelVms?: number;
}

export interface HypervDisk {
  path: string;
  controllerType: string;
  controllerNumber: number;
  controllerLocation: number;
  fileSizeBytes: number;
  sizeBytes: number;
}

export interface HypervVm {
  id: string;
  name: string;
  state: string;
  generation: number;
  version: string;
  processorCount: number;
  memoryStartupBytes: number;
  checkpointType: string;
  backupIntegration: boolean;
  configurationLocation: string;
  disks: HypervDisk[];
  staleCheckpoints: string[];
  notes?: string;
  /** Cluster hosts: the node that owns the VM. */
  node?: string;
}

export interface HypervInventory {
  computerName: string;
  os: string;
  vms: HypervVm[];
}

export interface HypervHost {
  id: string;
  name: string;
  slug: string;
  mode: 'local' | 'remote' | 'cluster';
  agent_id: string;
  agent_name: string | null;
  agent_status: string | null;
  address: string | null;
  username: string | null;
  inventory_at: string | null;
  inventory_error: string | null;
  inventory_requested_at: string | null;
  vm_count: number | null;
}

export interface HypervVmRunResult {
  vmId: string;
  name: string;
  status: 'success' | 'failed';
  snapshotId?: string;
  consistency?: 'application' | 'crash';
  error?: string;
}

export interface HypervVmProtection {
  vmId: string;
  jobs: { id: string; name: string; enabled: boolean }[];
  lastBackup: (HypervVmRunResult & { jobId: string; finishedAt: string | null }) | null;
}

export interface HypervHostDetail extends HypervHost {
  inventory: HypervInventory | null;
  protection: HypervVmProtection[];
}

export interface HypervVmSnapshot {
  jobId: string;
  jobName: string;
  snapshot: { id: string; short_id: string; time: string; hostname: string; tags?: string[] };
}

// --- Proxmox VE -----------------------------------------------------------------
// Mirrors server/src/proxmox/proxmox.contract.ts (dates arrive as ISO strings).

export type ProxmoxGuestType = 'qemu' | 'lxc';
export type ProxmoxMethod = 'vzdump' | 'block' | 'files';
export type ProxmoxMethodChoice = 'auto' | 'vzdump';
export type ProxmoxVzdumpMode = 'snapshot' | 'suspend' | 'stop';

export interface ProxmoxAgentInfo {
  clusterId: string;
  clusterName: string | null;
  node: string;
  pveVersion: string;
}

export interface ProxmoxGuestDisk {
  key: string;
  volid: string;
  storage: string;
  sizeBytes: number;
  format?: string;
  backup: boolean;
}

export interface ProxmoxGuest {
  vmid: number;
  type: ProxmoxGuestType;
  name: string;
  node: string;
  status: string;
  template: boolean;
  lock?: string;
  haState?: string;
  pool?: string;
  tags: string[];
  guestAgent?: boolean;
  unprivileged?: boolean;
  cores?: number;
  memoryBytes?: number;
  disks: ProxmoxGuestDisk[];
  autoMethod: ProxmoxMethod;
  autoMethodReason?: string;
  staleSnapshots: string[];
}

export interface ProxmoxStorage {
  id: string;
  type: string;
  shared: boolean;
  content: string[];
  nodes: string[];
  snapshots: boolean;
  availBytes?: number;
  totalBytes?: number;
}

export interface ProxmoxInventory {
  clusterName: string | null;
  pveVersion: string;
  readBy: string;
  nodes: { name: string; online: boolean }[];
  storages: ProxmoxStorage[];
  guests: ProxmoxGuest[];
}

export interface ProxmoxJobConfig {
  allGuests: boolean;
  vmids: number[];
  pools?: string[];
  pveTags?: string[];
  excludeVmids?: number[];
  types?: ProxmoxGuestType[];
  includeTemplates?: boolean;
  vmMethod?: ProxmoxMethodChoice;
  ctMethod?: ProxmoxMethodChoice;
  vzdumpMode?: ProxmoxVzdumpMode;
  requireConsistent?: boolean;
  parallelPerNode?: number;
  maxParallel?: number;
}

export interface ProxmoxGuestResult {
  vmid: number;
  type: ProxmoxGuestType;
  name: string;
  node: string;
  status: 'success' | 'failed' | 'moved' | 'skipped';
  movedTo?: string;
  method?: ProxmoxMethod;
  consistency?: 'application' | 'crash' | 'offline';
  cbt?: 'incremental' | 'full';
  cbtReason?: string;
  snapshotId?: string;
  dataAdded?: number;
  bytesRead?: number;
  totalBytes?: number;
  durationSeconds?: number;
  error?: string;
  warnings?: string[];
}

export interface ProxmoxRunSummary {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  cancelled: number;
  dataAdded: number;
  bytesRead: number;
}

/** Full-guest restore, or a file restore into a container (`files` snapshots). */
export interface ProxmoxRestoreSpec {
  clusterId: string;
  vmid: number;
  guestType: ProxmoxGuestType;
  action: 'guest' | 'files' | 'vm-files';
  targetNode: string;
  newVmid?: number;
  replaceOriginal?: boolean;
  storage?: string;
  unique?: boolean;
  name?: string;
  start?: boolean;
  bwlimitKiB?: number;
  /** guest, block snapshots: start from the backup, move the disks while running. */
  liveRestore?: boolean;
  overlayStorage?: string;
  targetVmid?: number;
  /** vm-files: absolute folder on the target node. */
  targetPath?: string;
}

export interface ProxmoxCluster {
  id: string;
  name: string;
  slug: string;
  pve_cluster_id: string;
  cluster_name: string | null;
  primary_agent_id: string;
  agent_name: string | null;
  agent_status: string | null;
  inventory_at: string | null;
  inventory_error: string | null;
  inventory_requested_at: string | null;
  guest_count: number | null;
  node_count: number | null;
  /** Null when the cluster registered itself through its first node agent. */
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProxmoxNodeView {
  name: string;
  online: boolean;
  agentId: string | null;
  agentName: string | null;
  agentStatus: string | null;
}

export interface ProxmoxGuestProtection {
  vmid: number;
  jobs: { id: string; name: string; enabled: boolean }[];
  lastBackup: (ProxmoxGuestResult & { jobId: string; finishedAt: string | null }) | null;
}

export interface ProxmoxClusterDetail extends ProxmoxCluster {
  inventory: ProxmoxInventory | null;
  nodes: ProxmoxNodeView[];
  protection: ProxmoxGuestProtection[];
}

export interface ProxmoxCandidate {
  agentId: string;
  agentName: string;
  agentStatus: string;
  info: ProxmoxAgentInfo;
  registeredClusterId: string | null;
}

export interface ProxmoxGuestIssue {
  clusterId: string;
  clusterName: string;
  vmid: number;
  name: string;
  type: ProxmoxGuestType;
  error?: string;
  finishedAt?: string | null;
}

export interface ProxmoxSummary {
  clusters: number;
  guests: number;
  unprotected: ProxmoxGuestIssue[];
  failed: ProxmoxGuestIssue[];
  nodesWithoutAgent: { clusterId: string; clusterName: string; node: string }[];
}

export interface ProxmoxRunItem {
  id: string;
  vmid: number;
  guestType: ProxmoxGuestType;
  name: string;
  node: string;
  agentId: string | null;
  status: 'queued' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';
  method: ProxmoxMethod | null;
  result: ProxmoxGuestResult | null;
  progress: Record<string, unknown> | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ProxmoxGuestSnapshot {
  jobId: string;
  jobName: string;
  snapshot: { id: string; short_id: string; time: string; hostname: string; tags?: string[]; paths?: string[] };
}

/**
 * The method a Proxmox snapshot was made with. There is no method tag (it
 * would split the retention groups): a vzdump snapshot holds one stdin file
 * named vzdump-<type>-<vmid>.vma|tar, block (VM) and files (CT) snapshots hold
 * the guest's mount directory; the pve-type tag tells those two apart.
 */
export function proxmoxSnapshotMethod(
  snapshot: { tags?: string[]; paths?: string[] } | undefined,
): ProxmoxMethod | null {
  if (!snapshot) return null;
  const paths = snapshot.paths ?? [];
  if (paths.some((p) => /(^|\/)vzdump-(qemu|lxc)-\d+\.(vma|tar)$/.test(p))) return 'vzdump';
  const type = (snapshot.tags ?? []).find((x) => x.startsWith('pve-type:'))?.slice('pve-type:'.length);
  if (type === 'qemu') return 'block';
  if (type === 'lxc') return 'files';
  return null;
}

/** Calls of the /proxmox API. */
export const proxmoxApi = {
  clusters: () => api.get<ProxmoxCluster[]>('/proxmox/clusters'),
  cluster: (idOrSlug: string) => api.get<ProxmoxClusterDetail>(`/proxmox/clusters/${idOrSlug}`),
  update: (idOrSlug: string, body: { name?: string; primaryAgentId?: string }) =>
    api.patch<ProxmoxClusterDetail>(`/proxmox/clusters/${idOrSlug}`, body),
  remove: (idOrSlug: string) => api.del(`/proxmox/clusters/${idOrSlug}`),
  refresh: (idOrSlug: string) => api.post<{ requestedAt: string }>(`/proxmox/clusters/${idOrSlug}/refresh`),
  candidates: () => api.get<ProxmoxCandidate[]>('/proxmox/candidates'),
  summary: () => api.get<ProxmoxSummary>('/proxmox/summary'),
  guestSnapshots: (idOrSlug: string, vmid: number) =>
    api.get<ProxmoxGuestSnapshot[]>(`/proxmox/clusters/${idOrSlug}/guests/${vmid}/snapshots`),
  runItems: (runId: string) => api.get<ProxmoxRunItem[]>(`/proxmox/runs/${runId}/items`),
};
