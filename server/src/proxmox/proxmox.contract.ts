/**
 * Proxmox VE — the contract between the server, the Go agent
 * (agent/proxmox.go: ProxmoxTask & co.) and the client (client/src/core/api.ts).
 * Keep all three in sync. Design: docs/superpowers/specs/2026-11-14-proxmox-design.md
 *
 * NOTE: everything PVE-specific here (commands, paths, behaviour) is built on
 * assumptions that were not yet verified on a real PVE host.
 */

/** Agents announce this capability when they run on a PVE node (or its mock). */
export const AGENT_CAPABILITY_PROXMOX = 'proxmox';

/** Task id prefix of an inventory task; the rest is the cluster id. */
export const PROXMOX_INVENTORY_TASK_PREFIX = 'pveinv-';
/** Task id prefix of a run's retention task (forget + prune); the rest is the run id. */
export const PROXMOX_RETENTION_TASK_PREFIX = 'pveret-';

/** Snapshot tag every Proxmox backup carries. */
export const PROXMOX_SNAPSHOT_TAG = 'amber-proxmox';
export const pveClusterTag = (slug: string): string => `pve-cluster:${slug}`;
export const pveGuestTag = (vmid: number): string => `pve-guest:${vmid}`;
/** restic --host of every snapshot of a cluster, whichever node made it. */
export const pveResticHost = (slug: string): string => `pve-${slug}`;

export type ProxmoxGuestType = 'qemu' | 'lxc';
/** vzdump: full stream; block: VM segments + dirty bitmap; files: CT file backup. */
export type ProxmoxMethod = 'vzdump' | 'block' | 'files';
export type ProxmoxMethodChoice = 'auto' | 'vzdump';
export type ProxmoxVzdumpMode = 'snapshot' | 'suspend' | 'stop';

// --- Poll ---------------------------------------------------------------------

/** What an agent on a PVE node announces in every poll (`PollDto.proxmox`). */
export interface ProxmoxAgentInfo {
  /**
   * Stable id of the cluster (or standalone node): sha256 hex of
   * /etc/pve/pve-root-ca.pem, which every node of a cluster shares.
   */
  clusterId: string;
  /** corosync cluster name; null on a standalone node. */
  clusterName: string | null;
  /** This node's PVE node name. */
  node: string;
  /** `pveversion` output, e.g. "pve-manager/8.2.4/…". */
  pveVersion: string;
}

// --- Inventory ----------------------------------------------------------------

export interface ProxmoxGuestDisk {
  /** Config key: scsi0, virtio1, sata0, ide0, efidisk0, tpmstate0, rootfs, mp0, … */
  key: string;
  /** PVE volume id, e.g. "local-zfs:vm-100-disk-0". */
  volid: string;
  storage: string;
  sizeBytes: number;
  /** qcow2 | raw | subvol | vmdk … */
  format?: string;
  /** false when the disk/mount point has backup=0. */
  backup: boolean;
}

export interface ProxmoxGuest {
  vmid: number;
  type: ProxmoxGuestType;
  name: string;
  /** Node the guest is on right now. */
  node: string;
  /** running | stopped | paused | … */
  status: string;
  template: boolean;
  /** PVE config lock (backup, snapshot, migrate, …), if any. */
  lock?: string;
  /** HA state when the guest is HA-managed. */
  haState?: string;
  pool?: string;
  tags: string[];
  /** qemu: `agent: 1` in the config (guest agent enabled → fs-freeze). */
  guestAgent?: boolean;
  /** lxc: unprivileged container. */
  unprivileged?: boolean;
  cores?: number;
  memoryBytes?: number;
  disks: ProxmoxGuestDisk[];
  /** What method `auto` picks for this guest, and why when it falls back. */
  autoMethod: ProxmoxMethod;
  autoMethodReason?: string;
  /** amber-* PVE snapshots left behind (agent crash); removed on the next backup. */
  staleSnapshots: string[];
}

export interface ProxmoxStorage {
  id: string;
  /** dir, nfs, cifs, zfspool, lvmthin, lvm, rbd, cephfs, btrfs, pbs, … */
  type: string;
  shared: boolean;
  /** Content types: images, rootdir, backup, iso, … */
  content: string[];
  /** Nodes the storage is restricted to; empty = all. */
  nodes: string[];
  /** Whether Amber can snapshot volumes on it (block/files methods). */
  snapshots: boolean;
  /** Free/total bytes as seen from the inventorying node, if known. */
  availBytes?: number;
  totalBytes?: number;
}

export interface ProxmoxNodeInfo {
  name: string;
  online: boolean;
}

export interface ProxmoxInventory {
  clusterName: string | null;
  pveVersion: string;
  /** Node that read the inventory. */
  readBy: string;
  nodes: ProxmoxNodeInfo[];
  storages: ProxmoxStorage[];
  guests: ProxmoxGuest[];
}

// --- Jobs ---------------------------------------------------------------------

/** Which guests a Proxmox job backs up, and how (`backup_jobs.proxmox_config`). */
export interface ProxmoxJobConfig {
  /** Every guest of the cluster, including guests created later (minus excludeVmids). */
  allGuests: boolean;
  /** Explicit guests when allGuests is false. */
  vmids: number[];
  /** Also every guest of these PVE pools (allGuests false). */
  pools?: string[];
  /** Also every guest carrying one of these PVE tags (allGuests false). */
  pveTags?: string[];
  excludeVmids?: number[];
  /** Guest types to include (default both). */
  types?: ProxmoxGuestType[];
  /** Templates are skipped unless this is set. */
  includeTemplates?: boolean;
  /** auto: block for VMs on snapshot-capable storage, else vzdump. */
  vmMethod?: ProxmoxMethodChoice;
  /** auto: files for CTs on snapshot-capable storage, else vzdump. */
  ctMethod?: ProxmoxMethodChoice;
  /** vzdump --mode for the vzdump method (default snapshot). */
  vzdumpMode?: ProxmoxVzdumpMode;
  /** Fail a running VM instead of taking a crash-consistent backup (no guest agent). */
  requireConsistent?: boolean;
  /** Guests backed up at the same time on one node (1–4, default 1). */
  parallelPerNode?: number;
  /** Guests backed up at the same time across the cluster (default: unlimited). */
  maxParallel?: number;
}

// --- Agent tasks --------------------------------------------------------------

/**
 * Change-tracking state of one guest in one job, carried from a successful
 * backup to the next (`proxmox_job_guests.cbt`). Owned by the agent; the
 * server stores it opaquely apart from these fields.
 */
export interface ProxmoxCbtState {
  /** Name of the QEMU dirty bitmap created before the last snapshot. */
  bitmap: string;
  /** Node whose QEMU process holds the bitmap. */
  node: string;
  /** Segment size the parent snapshot used. */
  segmentBytes: number;
  /** Disks of the parent snapshot (a resize forces a full read). */
  disks: { key: string; sizeBytes: number }[];
}

export interface ProxmoxGuestRef {
  vmid: number;
  type: ProxmoxGuestType;
  name: string;
  /** Node the server expects the guest on. */
  node: string;
}

/**
 * Full-guest restore (`restore_runs.destination.proxmox`, action 'guest'), a
 * file restore into a container (action 'files', `files` snapshots only), or
 * a file restore out of a VM backup to a directory on the node (action
 * 'vm-files', `block` snapshots only; the paths come as the restore's
 * includedPaths, each optionally prefixed with a disk/partition selector:
 * `p2:/etc/nginx`, `scsi0p1:/home`, `scsi1:/srv`).
 */
export interface ProxmoxRestoreSpec {
  clusterId: string;
  /** Guest the snapshot belongs to (from its pve-guest tag). */
  vmid: number;
  guestType: ProxmoxGuestType;
  action: 'guest' | 'files' | 'vm-files';
  /** Node to restore on; its agent runs the restore. */
  targetNode: string;
  // action guest
  /** New VMID; default: the cluster's next free id. */
  newVmid?: number;
  /** Restore over the original guest (same vmid; it is stopped and overwritten). */
  replaceOriginal?: boolean;
  /** Target storage for all disks; default: the original storages. */
  storage?: string;
  /** Regenerate MAC addresses etc. (qmrestore/pct restore --unique). */
  unique?: boolean;
  /** Name/hostname of the restored guest. */
  name?: string;
  start?: boolean;
  bwlimitKiB?: number;
  /**
   * action guest, `block` snapshots: start the VM at once from qcow2 overlays
   * backed by the backup, then move its disks into `storage` (default: the
   * original storages) while it runs. The VM depends on the agent until the
   * moves finish. Always a new VMID.
   */
  liveRestore?: boolean;
  /** Live restore: dir/NFS/CIFS storage that holds the temporary qcow2 overlays. */
  overlayStorage?: string;
  // action files
  /** Container that receives the files (default: vmid). */
  targetVmid?: number;
  // action vm-files
  /** Absolute directory on the target node (not /); files land in <targetPath>/<disk>-p<N>/. */
  targetPath?: string;
}

/** The Proxmox part of an AgentTask (`AgentTask.proxmox`). */
export interface ProxmoxTaskPayload {
  clusterId: string;
  /** restic --host for backups, and the slug in the pve-cluster tag. */
  clusterSlug: string;
  // proxmox-backup (one guest per task; task id = proxmox_run_items.id)
  guest?: ProxmoxGuestRef;
  vmMethod?: ProxmoxMethodChoice;
  ctMethod?: ProxmoxMethodChoice;
  vzdumpMode?: ProxmoxVzdumpMode;
  requireConsistent?: boolean;
  /** Last successful snapshot of this guest in this job, for --parent. */
  parentSnapshotId?: string;
  /** Change tracking from that snapshot; absent → full read. */
  cbt?: ProxmoxCbtState;
  // proxmox-restore
  restore?: ProxmoxRestoreSpec;
}

/** One guest's outcome (`TaskResult.proxmoxGuest`, stored on the run item). */
export interface ProxmoxGuestResult {
  vmid: number;
  type: ProxmoxGuestType;
  name: string;
  node: string;
  /**
   * moved: the guest is no longer on this node (`movedTo`); the server hands
   * the item to that node's agent. skipped: e.g. the guest no longer exists.
   */
  status: 'success' | 'failed' | 'moved' | 'skipped';
  movedTo?: string;
  method?: ProxmoxMethod;
  /** application: guest fs-freeze; crash: running without guest agent; offline: guest was stopped. */
  consistency?: 'application' | 'crash' | 'offline';
  /** block method: whether only changed segments were read. */
  cbt?: 'incremental' | 'full';
  cbtReason?: string;
  /** State for the next run; null clears it. */
  nextCbt?: ProxmoxCbtState | null;
  snapshotId?: string;
  dataAdded?: number;
  /** Bytes actually read from the guest's disks. */
  bytesRead?: number;
  totalBytes?: number;
  durationSeconds?: number;
  error?: string;
  warnings?: string[];
}

/** `job_runs.stats.proxmoxGuests` once a run is settled. */
export interface ProxmoxRunSummary {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  cancelled: number;
  dataAdded: number;
  bytesRead: number;
}

/** Restore outcome (`restore_runs.stats.proxmoxRestore`). */
export interface ProxmoxRestoreResult {
  sourceVmid: number;
  vmid: number;
  node: string;
  replacedOriginal?: boolean;
  liveRestore?: boolean;
  /** vm-files: what was copied, from which partitions, to where. */
  filesRestored?: number;
  bytesRestored?: number;
  partitions?: string[];
  targetPath?: string;
  warnings?: string[];
}

// --- API shapes (server → client) ----------------------------------------------

export interface PublicProxmoxCluster {
  id: string;
  name: string;
  slug: string;
  pve_cluster_id: string;
  cluster_name: string | null;
  /** Agent that reads the inventory and runs retention/checks/stats. */
  primary_agent_id: string;
  agent_name: string | null;
  agent_status: string | null;
  inventory_at: Date | null;
  inventory_error: string | null;
  inventory_requested_at: Date | null;
  guest_count: number | null;
  node_count: number | null;
  /** Null when the cluster registered itself through its first node agent. */
  owner_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProxmoxNodeView {
  name: string;
  online: boolean;
  /** Agent running on the node (linked by its poll announcement). */
  agentId: string | null;
  agentName: string | null;
  agentStatus: string | null;
}

export interface ProxmoxGuestProtection {
  vmid: number;
  jobs: { id: string; name: string; enabled: boolean }[];
  lastBackup: (ProxmoxGuestResult & { jobId: string; finishedAt: Date | null }) | null;
}

export interface ProxmoxClusterDetail extends PublicProxmoxCluster {
  inventory: ProxmoxInventory | null;
  nodes: ProxmoxNodeView[];
  protection: ProxmoxGuestProtection[];
}

/** An agent on a PVE node, for "add cluster" (GET /proxmox/candidates). */
export interface ProxmoxCandidate {
  agentId: string;
  agentName: string;
  agentStatus: string;
  info: ProxmoxAgentInfo;
  /** Amber cluster this agent's PVE cluster is already registered as. */
  registeredClusterId: string | null;
}

export interface ProxmoxGuestIssue {
  clusterId: string;
  clusterName: string;
  vmid: number;
  name: string;
  type: ProxmoxGuestType;
  error?: string;
  finishedAt?: Date | null;
}

export interface ProxmoxSummary {
  clusters: number;
  guests: number;
  unprotected: ProxmoxGuestIssue[];
  failed: ProxmoxGuestIssue[];
  /** Nodes with guests but no agent. */
  nodesWithoutAgent: { clusterId: string; clusterName: string; node: string }[];
}

/** A run's per-guest rows (GET /proxmox/runs/:runId/items). */
export interface ProxmoxRunItemView {
  id: string;
  vmid: number;
  guestType: ProxmoxGuestType;
  name: string;
  node: string;
  agentId: string | null;
  status: 'queued' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';
  method: ProxmoxMethod | null;
  result: ProxmoxGuestResult | null;
  /** Live progress while running (same fields as RunStats progress). */
  progress: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}
