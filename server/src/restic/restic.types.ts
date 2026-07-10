import { CredentialFile } from '../targets/backend-registry';
import { ResticOptions, RunStats } from '../database/database.types';

/** Everything restic needs to talk to one repository. */
export interface ResticContext {
  repository: string;
  password: string;
  env: Record<string, string>;
  credentialFiles: CredentialFile[];
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
