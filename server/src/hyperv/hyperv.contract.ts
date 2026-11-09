import {
  HypervCheckpointMode,
  HypervHostMode,
  HypervRestoreSpec,
} from '../database/database.types';

/**
 * The Hyper-V part of an AgentTask — the contract with the Go agent
 * (agent/hyperv.go: HypervTask). Keep both in sync.
 */

/** Agents announce this capability when Hyper-V (or its mock) is usable. */
export const AGENT_CAPABILITY_HYPERV = 'hyperv';

/** Task id prefix of an inventory task; the rest is the host id. */
export const HYPERV_INVENTORY_TASK_PREFIX = 'hvinv-';

/** How the agent reaches the host. Remote credentials are decrypted only here. */
export interface HypervConnection {
  mode: HypervHostMode;
  /** remote: the host's DNS name / address. */
  address?: string;
  username?: string;
  password?: string;
}

export interface HypervTaskPayload {
  connection: HypervConnection;
  // hyperv-backup
  allVms?: boolean;
  vmIds?: string[];
  excludeVmIds?: string[];
  checkpointMode?: HypervCheckpointMode;
  // hyperv-restore
  restore?: HypervRestoreSpec & {
    /** Folder on the host that receives the VM's files. */
    targetPath: string;
  };
}

/** Outcome of one VM in a Hyper-V backup run (`job_runs.stats.hypervVms`). */
export interface HypervVmRunResult {
  vmId: string;
  name: string;
  status: 'success' | 'failed';
  snapshotId?: string;
  /** application: production checkpoint; crash: standard checkpoint. */
  consistency?: 'application' | 'crash';
  error?: string;
  dataAdded?: number;
  totalBytes?: number;
  durationSeconds?: number;
}

/** Snapshot tag every Hyper-V backup carries. */
export const HYPERV_SNAPSHOT_TAG = 'amber-hyperv';
/** Snapshot tag naming the VM a snapshot holds. */
export const vmTag = (vmId: string): string => `vm:${vmId.toLowerCase()}`;
