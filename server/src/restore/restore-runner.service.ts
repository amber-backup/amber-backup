import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Db, KYSELY } from '../database/database.module';
import { ResticService } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';
import { loadConfig } from '../config/configuration';
import { RestoreDestination, RestoreOptions, RunStats } from '../database/database.types';

/** Download artifacts live this long before cleanup (§10.3). */
const DOWNLOAD_TTL_MS = 24 * 3600_000;

/**
 * Executes local restore runs (§10). Server executor handles original (local
 * source), alternate_path (server), and download modes. Agent-bound restores
 * are left queued for the agent.
 */
@Injectable()
export class RestoreRunnerService implements OnApplicationShutdown {
  private readonly logger = new Logger(RestoreRunnerService.name);
  private readonly running = new Map<string, AbortController>();

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
      let downloadRef: string | null = null;
      let downloadExpires: Date | null = null;

      if (run.mode === 'download') {
        targetPath = path.join(
          loadConfig().restoreTmpDir,
          `restore-${restoreRunId}`,
        );
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
          onProgress: (s) => void this.writeStats(restoreRunId, s),
          onLog: appendLog,
        },
        abort.signal,
      );

      if (run.mode === 'download' && !options.dryRun) {
        const archive = `${targetPath}.tar.gz`;
        await this.createArchive(targetPath, archive);
        await fs.rm(targetPath, { recursive: true, force: true });
        downloadRef = archive;
        downloadExpires = new Date(Date.now() + DOWNLOAD_TTL_MS);
        appendLog(`[download] archive ready: ${path.basename(archive)}`);
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

  private writeStats(id: string, stats: RunStats): Promise<unknown> {
    return this.db
      .updateTable('restore_runs')
      .set({ stats: JSON.stringify(stats) })
      .where('id', '=', id)
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
