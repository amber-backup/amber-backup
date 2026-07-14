import { CredentialFile } from '../targets/backend-registry';
import { ResticOptions, RunStats } from '../database/database.types';

/** Everything restic needs to talk to one repository. */
export interface ResticContext {
  repository: string;
  password: string;
  env: Record<string, string>;
  credentialFiles: CredentialFile[];
  /**
   * Extra restic global options prepended before the subcommand (e.g. the
   * SFTP `-o sftp.command=...`). May reference credential file paths via the
   * `{{credentialFile:<filename>}}` placeholder.
   */
  extraArgs?: string[];
}

export interface ResticSnapshot {
  id: string;
  short_id: string;
  time: string;
  hostname: string;
  username?: string;
  tags?: string[];
  paths: string[];
  summary?: {
    total_files_processed?: number;
    total_bytes_processed?: number;
  };
}

/** Output of `restic stats --json` (fields present depend on the mode). */
export interface ResticStats {
  total_size: number;
  total_file_count?: number;
  total_blob_count?: number;
  snapshots_count?: number;
  total_uncompressed_size?: number;
  compression_ratio?: number;
}

export interface ResticLsEntry {
  name: string;
  type: 'file' | 'dir' | string;
  path: string;
  size?: number;
  mtime?: string;
}

export interface BackupResult {
  snapshotId: string | null;
  stats: RunStats;
}

export interface ForgetResult {
  removed: number;
  raw: unknown;
}

export type ProgressCallback = (stats: RunStats) => void;
export type LogCallback = (line: string) => void;

export interface RunHandle {
  /** Resolves when the process exits. */
  done: Promise<{ code: number; stdout: string; stderr: string }>;
  /** Kill the underlying process. */
  cancel(): void;
}

export type { ResticOptions };
