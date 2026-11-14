import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { sql } from 'kysely';
import { Db, KYSELY } from '../database/database.module';
import { ResticService } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';
import { loadConfig } from '../config/configuration';
import { RestoreDestination, RestoreOptions, RunStats } from '../database/database.types';

/** Download artifacts live this long before cleanup (§10.3). */
const DOWNLOAD_TTL_MS = 24 * 3600_000;

/** Live progress is written at most this often. */
const PROGRESS_WRITE_INTERVAL_MS = 1000;

/** How often expired download archives are deleted. */
const DOWNLOAD_SWEEP_INTERVAL_MS = 10 * 60_000;

/** Server-side restore artifacts: `restore-<id>` (dir) and `restore-<id>.tar.gz`. */
const ARTIFACT_RE = /^restore-[0-9a-f-]+(?:\.tar\.gz)?$/i;

/**
 * Executes local restore runs (§10). Server executor handles original (local
 * source), alternate_path (server), and download modes. Agent-bound restores
 * are left queued for the agent.
 */
@Injectable()
export class RestoreRunnerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RestoreRunnerService.name);
  private readonly running = new Map<string, AbortController>();

  /** Drops restore artifacts no run owns anymore (left by a crash or restart). */
  async onApplicationBootstrap(): Promise<void> {
    await this.removeOrphanedArtifacts().catch((e) =>
      this.logger.warn(`Cleaning up restore artifacts failed: ${e}`),
    );
  }

  /** Abort in-flight restores on shutdown so restic children don't block exit. */
  onApplicationShutdown(): void {
    for (const ctrl of this.running.values()) ctrl.abort();
  }

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly restic: ResticService,
    private readonly targets: TargetsService,
  ) {}

  cancel(id: string): boolean {
    const c = this.running.get(id);
    if (c) {
      c.abort();
      return true;
    }
    return false;
  }

  async dispatch(restoreRunId: string): Promise<void> {
    const run = await this.db
      .selectFrom('restore_runs')
      .select(['id', 'destination', 'mode'])
      .where('id', '=', restoreRunId)
      .executeTakeFirst();
    if (!run) return;
    const dest: RestoreDestination =
      typeof run.destination === 'string'
        ? JSON.parse(run.destination)
        : run.destination;
    // Restores targeting an agent host are picked up by that agent's poll.
    if (dest.agentId) return;
    void this.executeLocal(restoreRunId).catch((e) =>
      this.logger.error(`Restore ${restoreRunId} failed: ${e}`),
    );
  }

  async executeLocal(restoreRunId: string): Promise<void> {
    const run = await this.db
      .selectFrom('restore_runs')
      .selectAll()
      .where('id', '=', restoreRunId)
      .executeTakeFirst();
    if (!run) return;

    const abort = new AbortController();
    this.running.set(restoreRunId, abort);
    const logLines: string[] = [];
    const appendLog = (l: string) => {
      logLines.push(l);
      if (logLines.length > 1000) logLines.shift();
    };

    const options: RestoreOptions =
      typeof run.options === 'string' ? JSON.parse(run.options) : run.options;
    const destination: RestoreDestination =
      typeof run.destination === 'string'
        ? JSON.parse(run.destination)
        : run.destination;
    const includedPaths: string[] | null = run.included_paths
      ? typeof run.included_paths === 'string'
        ? JSON.parse(run.included_paths)
        : run.included_paths
      : null;

    await this.db
      .updateTable('restore_runs')
      .set({ status: 'running', started_at: new Date() })
      .where('id', '=', restoreRunId)
      .execute();

    // Decrypted data on the server: removed again on any failure.
    let scratchDir: string | null = null;
    let archive: string | null = null;
    try {
      const resolved = await this.targets.resolveForRestore(run);
      const ctx = {
        repository: resolved.repository,
        password: resolved.password,
        env: resolved.env,
        credentialFiles: resolved.credentialFiles,
        extraArgs: resolved.extraArgs,
      };

      let targetPath: string;
      let lastProgressWrite = 0;
      let downloadRef: string | null = null;
      let downloadExpires: Date | null = null;

      if (run.mode === 'download') {
        targetPath = path.join(
          loadConfig().restoreTmpDir,
          `restore-${restoreRunId}`,
        );
        scratchDir = targetPath;
        await fs.mkdir(targetPath, { recursive: true });
      } else if (run.mode === 'original') {
        // Restore absolute snapshot paths back to root.
        targetPath = destination.path || '/';
      } else {
        targetPath = destination.path || '';
        if (!targetPath) throw new Error('alternate_path requires a path');
      }

      const stats = await this.restic.restore(
        ctx,
        run.snapshot_id,
        targetPath,
        {
          include: includedPaths ?? options.include,
          exclude: options.exclude,
          overwrite: options.overwrite,
          verify: options.verify,
          delete: options.delete,
          dryRun: options.dryRun,
        },
        {
          onProgress: (s) => {
            // restic emits status lines many times a second; the final
            // figures are written with the result below.
            const now = Date.now();
            if (now - lastProgressWrite < PROGRESS_WRITE_INTERVAL_MS) return;
            lastProgressWrite = now;
            void this.writeStats(restoreRunId, s);
          },
          onLog: appendLog,
        },
        abort.signal,
      );

      if (run.mode === 'download' && !options.dryRun) {
        archive = `${targetPath}.tar.gz`;
        await this.createArchive(targetPath, archive);
        await fs.rm(targetPath, { recursive: true, force: true });
        downloadRef = archive;
        downloadExpires = new Date(Date.now() + DOWNLOAD_TTL_MS);
        appendLog(`[download] archive ready: ${path.basename(archive)}`);
      } else if (scratchDir) {
        // A dry run restores nothing worth keeping.
        await fs.rm(scratchDir, { recursive: true, force: true });
      }

      await this.db
        .updateTable('restore_runs')
        .set({
          status: 'success',
          finished_at: new Date(),
          stats: JSON.stringify(stats),
          destination: JSON.stringify({ ...destination, downloadRef }),
          download_expires_at: downloadExpires,
          log: logLines.join('\n'),
        })
        .where('id', '=', restoreRunId)
        .execute();
    } catch (err) {
      const aborted = abort.signal.aborted;
      appendLog(String(err));
      // Don't leave a partial restore or half-written archive behind.
      await this.removeArtifacts([scratchDir, archive]);
      await this.db
        .updateTable('restore_runs')
        .set({
          status: aborted ? 'cancelled' : 'failed',
          finished_at: new Date(),
          error: err instanceof Error ? err.message : String(err),
          log: logLines.join('\n'),
        })
        .where('id', '=', restoreRunId)
        .execute();
    } finally {
      this.running.delete(restoreRunId);
    }
  }

  /**
   * Deletes download archives whose time is up and clears their reference,
   * so decrypted restore data does not outlive the promised window (or fill
   * the server's disk).
   */
  @Interval(DOWNLOAD_SWEEP_INTERVAL_MS)
  async sweepExpiredDownloads(): Promise<number> {
    const expired = await this.db
      .selectFrom('restore_runs')
      .select(['id', 'destination'])
      .where('mode', '=', 'download')
      .where('download_expires_at', '<', new Date())
      .where(sql<boolean>`destination->>'downloadRef' is not null`)
      .execute();
    let removed = 0;
    for (const run of expired) {
      const destination: RestoreDestination =
        typeof run.destination === 'string'
          ? JSON.parse(run.destination)
          : run.destination;
      if (destination.downloadRef) {
        await this.removeArtifacts([destination.downloadRef]);
      }
      await this.db
        .updateTable('restore_runs')
        .set({
          destination: JSON.stringify({ ...destination, downloadRef: null }),
        })
        .where('id', '=', run.id)
        .execute();
      removed++;
    }
    if (removed > 0) {
      this.logger.log(`Deleted ${removed} expired restore download(s)`);
    }
    return removed;
  }

  /**
   * Removes `restore-*` entries of the restore temp dir that no live download
   * references: the directories and archives of restores that a crash or a
   * restart interrupted, and archives of runs that no longer exist.
   */
  async removeOrphanedArtifacts(): Promise<string[]> {
    const dir = loadConfig().restoreTmpDir;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return []; // no temp dir yet
    }
    const candidates = entries.filter((e) => ARTIFACT_RE.test(e));
    if (candidates.length === 0) return [];
    const live = await this.db
      .selectFrom('restore_runs')
      .select('destination')
      .where('mode', '=', 'download')
      .where('status', '=', 'success')
      .where((eb) =>
        eb.or([
          eb('download_expires_at', 'is', null),
          eb('download_expires_at', '>=', new Date()),
        ]),
      )
      .execute();
    const keep = new Set<string>();
    for (const row of live) {
      const destination: RestoreDestination =
        typeof row.destination === 'string'
          ? JSON.parse(row.destination)
          : row.destination;
      if (destination.downloadRef) keep.add(path.resolve(destination.downloadRef));
    }
    const removed: string[] = [];
    for (const entry of candidates) {
      const full = path.join(dir, entry);
      // A local restore of this process may be running into it right now
      // (only possible when this runs after startup).
      const id = entry.replace(/^restore-/, '').replace(/\.tar\.gz$/, '');
      if (this.running.has(id) || keep.has(path.resolve(full))) continue;
      await this.removeArtifacts([full]);
      removed.push(entry);
    }
    if (removed.length > 0) {
      this.logger.log(`Removed ${removed.length} orphaned restore artifact(s)`);
    }
    return removed;
  }

  private async removeArtifacts(paths: (string | null | undefined)[]): Promise<void> {
    for (const p of paths) {
      if (!p) continue;
      await fs
        .rm(p, { recursive: true, force: true })
        .catch((e) => this.logger.warn(`Could not remove ${p}: ${e}`));
    }
  }

  private writeStats(id: string, stats: RunStats): Promise<unknown> {
    return this.db
      .updateTable('restore_runs')
      .set({ stats: JSON.stringify(stats) })
      .where('id', '=', id)
      // A late progress write must not replace the final figures.
      .where('status', '=', 'running')
      .execute()
      .catch(() => undefined);
  }

  private createArchive(dir: string, out: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('tar', ['-czf', out, '-C', dir, '.']);
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c.toString()));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`tar failed: ${stderr}`)),
      );
    });
  }
}
