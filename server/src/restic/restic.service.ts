import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { loadConfig } from '../config/configuration';
import { RunStats, ResticOptions } from '../database/database.types';
import {
  BackupResult,
  ForgetResult,
  LogCallback,
  ProgressCallback,
  ResticContext,
  ResticLsEntry,
  ResticSnapshot,
} from './restic.types';

interface RunOptions {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
}

interface RunOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Low-level restic process executor. Prepares the environment (repository,
 * password, backend credentials, temp credential files), streams JSON output,
 * and cleans up transient secrets afterwards. Used for local runs; the agent
 * mirrors this logic on remote hosts.
 */
@Injectable()
export class ResticService {
  private readonly logger = new Logger(ResticService.name);
  private readonly binary = loadConfig().resticBinary;
  private readonly cacheDir = loadConfig().resticCacheDir;

  /** Prepares env + credential files, runs restic, guarantees cleanup. */
  private async run(
    ctx: ResticContext,
    args: string[],
    opts: RunOptions = {},
  ): Promise<RunOutcome> {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-restic-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RESTIC_REPOSITORY: ctx.repository,
      RESTIC_PASSWORD: ctx.password,
      RESTIC_CACHE_DIR: this.cacheDir,
      ...ctx.env,
    };

    try {
      for (const file of ctx.credentialFiles) {
        const fp = path.join(workDir, file.filename);
        await fs.writeFile(fp, file.content, { mode: 0o600 });
        env[file.envVar] = fp;
      }
      await fs.mkdir(this.cacheDir, { recursive: true }).catch(() => undefined);

      return await this.spawn(args, env, opts);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private spawn(
    args: string[],
    env: NodeJS.ProcessEnv,
    opts: RunOptions,
  ): Promise<RunOutcome> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { env });
      let stdout = '';
      let stderr = '';
      let stdoutBuf = '';
      let stderrBuf = '';

      if (opts.signal) {
        opts.signal.addEventListener('abort', () => child.kill('SIGTERM'), {
          once: true,
        });
      }

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        stdoutBuf += text;
        let idx: number;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line.trim()) opts.onStdoutLine?.(line);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        stderrBuf += text;
        let idx: number;
        while ((idx = stderrBuf.indexOf('\n')) >= 0) {
          const line = stderrBuf.slice(0, idx);
          stderrBuf = stderrBuf.slice(idx + 1);
          if (line.trim()) opts.onStderrLine?.(line);
        }
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  // --- High-level operations ------------------------------------------------

  /** Validates repository reachability; initializes it if missing. */
  async testConnection(
    ctx: ResticContext,
  ): Promise<{ ok: boolean; initialized: boolean; message: string }> {
    const cat = await this.run(ctx, ['cat', 'config', '--json']);
    if (cat.code === 0) {
      return { ok: true, initialized: false, message: 'Repository reachable' };
    }
    // Not initialized yet? Try to init.
    const init = await this.run(ctx, ['init', '--json']);
    if (init.code === 0) {
      return {
        ok: true,
        initialized: true,
        message: 'Repository initialized',
      };
    }
    return {
      ok: false,
      initialized: false,
      message: (init.stderr || cat.stderr || 'unknown error').trim(),
    };
  }

  async ensureInitialized(ctx: ResticContext): Promise<void> {
    const cat = await this.run(ctx, ['cat', 'config']);
    if (cat.code === 0) return;
    const init = await this.run(ctx, ['init']);
    if (init.code !== 0) {
      throw new Error(`restic init failed: ${init.stderr.trim()}`);
    }
  }

  async snapshots(
    ctx: ResticContext,
    filters: { host?: string; tags?: string[]; paths?: string[] } = {},
  ): Promise<ResticSnapshot[]> {
    const args = ['snapshots', '--json'];
    if (filters.host) args.push('--host', filters.host);
    for (const tag of filters.tags ?? []) args.push('--tag', tag);
    for (const p of filters.paths ?? []) args.push('--path', p);
    const res = await this.run(ctx, args);
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'snapshots failed');
    return JSON.parse(res.stdout || '[]') as ResticSnapshot[];
  }

  async ls(
    ctx: ResticContext,
    snapshotId: string,
    dir?: string,
  ): Promise<ResticLsEntry[]> {
    const args = ['ls', snapshotId, '--json'];
    if (dir) args.push(dir);
    const entries: ResticLsEntry[] = [];
    const res = await this.run(ctx, args, {
      onStdoutLine: (line) => {
        try {
          const obj = JSON.parse(line);
          if (obj.struct_type === 'node' || obj.name) {
            if (obj.path && obj.path !== dir) {
              entries.push({
                name: obj.name,
                type: obj.type,
                path: obj.path,
                size: obj.size,
                mtime: obj.mtime,
              });
            }
          }
        } catch {
          /* non-JSON line */
        }
      },
    });
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'ls failed');
    return entries;
  }

  async backup(
    ctx: ResticContext,
    paths: string[],
    options: ResticOptions,
    hooks: { onProgress?: ProgressCallback; onLog?: LogCallback } = {},
    signal?: AbortSignal,
  ): Promise<BackupResult> {
    const args = ['backup', '--json', ...paths];
    for (const tag of options.tags ?? []) args.push('--tag', tag);
    for (const ex of options.exclude ?? []) args.push('--exclude', ex);
    for (const ex of options.iexclude ?? []) args.push('--iexclude', ex);
    for (const ef of options.excludeFile ?? []) args.push('--exclude-file', ef);
    if (options.oneFileSystem) args.push('--one-file-system');
    if (options.excludeCaches) args.push('--exclude-caches');
    if (options.excludeLargerThan)
      args.push('--exclude-larger-than', options.excludeLargerThan);
    if (options.compression) args.push('--compression', options.compression);
    if (options.readConcurrency)
      args.push('--read-concurrency', String(options.readConcurrency));

    let stats: RunStats = {};
    let snapshotId: string | null = null;

    const res = await this.run(ctx, args, {
      signal,
      onStdoutLine: (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.message_type === 'status') {
            stats = { ...stats, percentDone: msg.percent_done };
            hooks.onProgress?.(stats);
          } else if (msg.message_type === 'summary') {
            stats = {
              filesNew: msg.files_new,
              filesChanged: msg.files_changed,
              filesUnmodified: msg.files_unmodified,
              dirsNew: msg.dirs_new,
              dataAdded: msg.data_added,
              totalBytesProcessed: msg.total_bytes_processed,
              totalFilesProcessed: msg.total_files_processed,
              totalDuration: msg.total_duration,
              percentDone: 1,
            };
            snapshotId = msg.snapshot_id ?? null;
            hooks.onProgress?.(stats);
          }
        } catch {
          hooks.onLog?.(line);
        }
      },
      onStderrLine: (line) => hooks.onLog?.(line),
    });

    // restic returns 3 for "some files could not be read" — still a snapshot.
    if (res.code !== 0 && res.code !== 3) {
      throw new Error(res.stderr.trim() || `restic backup exited ${res.code}`);
    }
    return { snapshotId, stats };
  }

  async forget(
    ctx: ResticContext,
    retention: NonNullable<ResticOptions['retention']>,
    hooks: { onLog?: LogCallback } = {},
  ): Promise<ForgetResult> {
    const args = ['forget', '--json'];
    const map: Record<string, number | undefined> = {
      '--keep-last': retention.keepLast,
      '--keep-hourly': retention.keepHourly,
      '--keep-daily': retention.keepDaily,
      '--keep-weekly': retention.keepWeekly,
      '--keep-monthly': retention.keepMonthly,
      '--keep-yearly': retention.keepYearly,
    };
    for (const [flag, value] of Object.entries(map)) {
      if (value != null) args.push(flag, String(value));
    }
    if (retention.keepWithin) args.push('--keep-within', retention.keepWithin);
    for (const tag of retention.keepTags ?? []) args.push('--keep-tag', tag);
    if (retention.prune) args.push('--prune');

    const res = await this.run(ctx, args, {
      onStderrLine: (line) => hooks.onLog?.(line),
    });
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || 'restic forget failed');
    }
    let raw: unknown = [];
    try {
      raw = JSON.parse(res.stdout || '[]');
    } catch {
      /* ignore */
    }
    let removed = 0;
    if (Array.isArray(raw)) {
      for (const g of raw as Array<{ remove?: unknown[] }>) {
        removed += g.remove?.length ?? 0;
      }
    }
    return { removed, raw };
  }

  async restore(
    ctx: ResticContext,
    snapshotId: string,
    target: string,
    options: {
      include?: string[];
      exclude?: string[];
      overwrite?: string;
      verify?: boolean;
      delete?: boolean;
      dryRun?: boolean;
    },
    hooks: { onProgress?: ProgressCallback; onLog?: LogCallback } = {},
    signal?: AbortSignal,
  ): Promise<RunStats> {
    const args = ['restore', snapshotId, '--json', '--target', target];
    for (const inc of options.include ?? []) args.push('--include', inc);
    for (const ex of options.exclude ?? []) args.push('--exclude', ex);
    if (options.overwrite) args.push('--overwrite', options.overwrite);
    if (options.verify) args.push('--verify');
    if (options.delete) args.push('--delete');
    if (options.dryRun) args.push('--dry-run');

    let stats: RunStats = {};
    const res = await this.run(ctx, args, {
      signal,
      onStdoutLine: (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.message_type === 'status') {
            stats = { ...stats, percentDone: msg.percent_done };
            hooks.onProgress?.(stats);
          } else if (msg.message_type === 'summary') {
            stats = {
              totalFilesProcessed: msg.total_files,
              totalBytesProcessed: msg.total_bytes,
              percentDone: 1,
            };
            hooks.onProgress?.(stats);
          }
        } catch {
          hooks.onLog?.(line);
        }
      },
      onStderrLine: (line) => hooks.onLog?.(line),
    });
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `restic restore exited ${res.code}`);
    }
    return stats;
  }

  async version(): Promise<string> {
    try {
      const res = await this.spawn(['version'], process.env, {});
      const match = res.stdout.match(/restic\s+([\d.]+)/);
      return match ? match[1] : res.stdout.trim();
    } catch {
      return 'unknown';
    }
  }
}
