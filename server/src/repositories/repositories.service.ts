import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Db, KYSELY } from '../database/database.module';
import { AccessControlService } from '../common/access-control.service';
import { RequestUser } from '../common/auth/request-user';
import { TargetsService } from '../targets/targets.service';
import { ResticService } from '../restic/restic.service';
import { CredentialFile } from '../targets/backend-registry';

/**
 * Decrypted repository access handed to a trusted CLI client so it can run
 * restic locally against a remote (network-backed) repository. Mirrors the
 * payload the Go agent receives — same field names — so the CLI can reuse the
 * agent's credential-file/placeholder handling verbatim.
 */
export interface ResolvedRepository {
  repository: string;
  password: string;
  env: Record<string, string>;
  credentialFiles: CredentialFile[];
  extraArgs?: string[];
}

/** A repository as exposed by the API/CLI (list shape). */
export interface PublicRepository {
  id: string;
  name: string;
  /** Name-derived, unique, kebab-case identifier; maintained by the app. */
  slug: string;
  /** Connection the repository lives on; null ⇒ local filesystem repo. */
  target_id: string | null;
  /** Human-readable connection name, or null for a local repo. */
  target: string | null;
  /** Backend type (s3, sftp, …); 'local' for a local filesystem repo. */
  type: string;
  repo_config: Record<string, unknown>;
  /** True when the repository overrides the connection's credentials. */
  has_credential_override: boolean;
  /** The (1:1) backup job that owns this repository. */
  job_id: string;
  job_name: string;
  location: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Cached repository figures. Refreshed after every successful backup run and
 * on demand; a failed refresh keeps the previous figures and records the error.
 */
export interface RepositoryStats {
  /** Deduplicated repository size in bytes; null until first read. */
  size_bytes: number | null;
  snapshot_count: number | null;
  /** When the figures were last read successfully; null until first read. */
  stats_at: Date | null;
  /** Last refresh failure, or null when the last refresh succeeded. */
  stats_error: string | null;
}

/** Detail shape adds the (freshly refreshed) repository figures. */
export type RepositoryDetail = PublicRepository & RepositoryStats;

/** Storage readings over time for the repositories a user can see. */
export interface RepositoryStatsHistoryResponse {
  /** Start of the requested window. */
  since: Date;
  repositories: { id: string; name: string }[];
  /** Readings inside the window plus, per repository, the last one before it. */
  points: { repository_id: string; measured_at: Date; size_bytes: number }[];
}

@Injectable()
export class RepositoriesService {
  private readonly logger = new Logger(RepositoriesService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly acl: AccessControlService,
    private readonly targets: TargetsService,
    private readonly restic: ResticService,
  ) {}

  private parseConfig(c: unknown): Record<string, unknown> {
    if (c == null) return {};
    return typeof c === 'string'
      ? (JSON.parse(c) as Record<string, unknown>)
      : (c as Record<string, unknown>);
  }

  /**
   * Repositories joined with their owning job (1:1) and — for non-local repos —
   * the connection they live on, for the name and backend type.
   */
  private baseQuery() {
    return this.db
      .selectFrom('repositories as r')
      .innerJoin('backup_jobs as j', 'j.repository_id', 'r.id')
      .leftJoin('targets as t', 't.id', 'r.target_id')
      .select([
        'r.id as id',
        'r.name as name',
        'r.slug as slug',
        'r.target_id as target_id',
        'r.repo_config as repo_config',
        'r.repo_password_secret_id as repo_password_secret_id',
        'r.credential_secret_id as credential_secret_id',
        'r.created_at as created_at',
        'r.updated_at as updated_at',
        'j.id as job_id',
        'j.name as job_name',
        'j.location as location',
        't.name as target_name',
        't.backend_type as backend_type',
      ]);
  }

  private toPublic(row: {
    id: string;
    name: string;
    slug: string;
    target_id: string | null;
    repo_config: unknown;
    credential_secret_id: string | null;
    created_at: Date;
    updated_at: Date;
    job_id: string;
    job_name: string;
    location: string;
    target_name: string | null;
    backend_type: string | null;
  }): PublicRepository {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      target_id: row.target_id,
      target: row.target_name ?? null,
      type: row.backend_type ?? 'local',
      repo_config: this.parseConfig(row.repo_config),
      has_credential_override: row.credential_secret_id != null,
      job_id: row.job_id,
      job_name: row.job_name,
      location: row.location,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async list(user: RequestUser): Promise<PublicRepository[]> {
    // A repository is visible when its owning job is (repos are 1:1 with jobs).
    const ids = await this.acl.visibleResourceIds(user, 'job');
    let q = this.baseQuery().orderBy('r.name', 'asc');
    if (ids !== 'all') {
      if (ids.length === 0) return [];
      q = q.where('j.id', 'in', ids);
    }
    return (await q.execute()).map((r) => this.toPublic(r));
  }

  async findOne(user: RequestUser, id: string): Promise<RepositoryDetail> {
    const row = await this.baseQuery()
      .where('r.id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Repository not found');
    await this.acl.assert(user, 'job', row.job_id, 'view');
    return { ...this.toPublic(row), ...(await this.refreshStats(id)) };
  }

  /** Refreshes a repository's figures after an access check (API entry point). */
  async refreshStatsFor(user: RequestUser, id: string): Promise<RepositoryStats> {
    const row = await this.db
      .selectFrom('repositories as r')
      .innerJoin('backup_jobs as j', 'j.repository_id', 'r.id')
      .select('j.id as job_id')
      .where('r.id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Repository not found');
    await this.acl.assert(user, 'job', row.job_id, 'view');
    return this.refreshStats(id);
  }

  /**
   * Reads size and snapshot count from restic and caches them on the
   * repository. A repository may be unreachable (offline backend, wrong
   * credentials, or one only the agent can reach) — then the previous figures
   * are kept and the error recorded, so callers degrade gracefully instead of
   * failing.
   */
  async refreshStats(id: string): Promise<RepositoryStats> {
    const repo = await this.db
      .selectFrom('repositories')
      .select([
        'id',
        'target_id',
        'repo_config',
        'repo_password_secret_id',
        'credential_secret_id',
        'size_bytes',
        'snapshot_count',
        'stats_at',
        'stats_error',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!repo) throw new NotFoundException('Repository not found');

    try {
      const ctx = await this.targets.resolveForJob({
        target_id: repo.target_id,
        repo_config: this.parseConfig(repo.repo_config),
        repo_password_secret_id: repo.repo_password_secret_id,
        credential_secret_id: repo.credential_secret_id,
      });
      const [snaps, stats] = await Promise.all([
        this.restic.snapshots(ctx),
        this.restic.stats(ctx),
      ]);
      const fresh: RepositoryStats = {
        size_bytes: stats.total_size ?? null,
        snapshot_count: snaps.length,
        stats_at: new Date(),
        stats_error: null,
      };
      await this.db
        .updateTable('repositories')
        .set(fresh)
        .where('id', '=', id)
        .execute();
      // Append to the history only when the figures actually changed so
      // manual refreshes don't pile up identical readings.
      const changed =
        repo.stats_at == null ||
        Number(repo.size_bytes) !== fresh.size_bytes ||
        repo.snapshot_count !== fresh.snapshot_count;
      if (changed && fresh.size_bytes != null) {
        await this.db
          .insertInto('repository_stats_history')
          .values({
            repository_id: id,
            measured_at: fresh.stats_at ?? undefined,
            size_bytes: fresh.size_bytes,
            snapshot_count: fresh.snapshot_count ?? 0,
          })
          .execute();
      }
      return fresh;
    } catch (e) {
      const stats_error = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Stats refresh for repository ${id} failed: ${stats_error}`);
      await this.db
        .updateTable('repositories')
        .set({ stats_error })
        .where('id', '=', id)
        .execute();
      return {
        size_bytes: repo.size_bytes == null ? null : Number(repo.size_bytes),
        snapshot_count: repo.snapshot_count,
        stats_at: repo.stats_at,
        stats_error,
      };
    }
  }

  /**
   * Storage readings for the dashboard growth chart, scoped to the
   * repositories whose job the user can view. Besides the readings inside the
   * window, the last reading before it is included per repository so the total
   * at the window start already counts every repository.
   */
  async statsHistory(
    user: RequestUser,
    days: number,
  ): Promise<RepositoryStatsHistoryResponse> {
    const since = new Date(Date.now() - days * 86400_000);
    const ids = await this.acl.visibleResourceIds(user, 'job');
    let reposQ = this.db
      .selectFrom('repositories as r')
      .innerJoin('backup_jobs as j', 'j.repository_id', 'r.id')
      .select(['r.id as id', 'r.name as name'])
      .orderBy('r.name', 'asc');
    if (ids !== 'all') {
      if (ids.length === 0) return { since, repositories: [], points: [] };
      reposQ = reposQ.where('j.id', 'in', ids);
    }
    const repositories = await reposQ.execute();
    const repoIds = repositories.map((r) => r.id);
    if (repoIds.length === 0) return { since, repositories, points: [] };

    const [inside, before] = await Promise.all([
      this.db
        .selectFrom('repository_stats_history')
        .select(['repository_id', 'measured_at', 'size_bytes'])
        .where('repository_id', 'in', repoIds)
        .where('measured_at', '>=', since)
        .orderBy('measured_at', 'asc')
        .execute(),
      this.db
        .selectFrom('repository_stats_history')
        .distinctOn('repository_id')
        .select(['repository_id', 'measured_at', 'size_bytes'])
        .where('repository_id', 'in', repoIds)
        .where('measured_at', '<', since)
        .orderBy('repository_id')
        .orderBy('measured_at', 'desc')
        .execute(),
    ]);
    const points = [...before, ...inside]
      .map((p) => ({
        repository_id: p.repository_id,
        measured_at: p.measured_at,
        size_bytes: Number(p.size_bytes),
      }))
      .sort((a, b) => +a.measured_at - +b.measured_at);
    return { since, repositories, points };
  }

  /**
   * Best-effort refresh after a backup run; never throws so a run's own
   * bookkeeping can't be disturbed by a stats failure.
   */
  refreshStatsInBackground(id: string): void {
    void this.refreshStats(id).catch((e) =>
      this.logger.warn(`Stats refresh for repository ${id} failed: ${e}`),
    );
  }

  /**
   * Resolves the decrypted credentials needed to run restic directly against a
   * repository (the `ambb repo use` CLI wrapper). Requires `manage` on the
   * owning job because it hands the caller the repository password and the
   * backend's plaintext credentials — a secret-disclosure operation, above the
   * 'operate' level that merely runs the job server-side.
   *
   * Only repositories on a shared connection can be reached from another host; a
   * local filesystem repository lives on the server and is rejected.
   */
  async resolve(user: RequestUser, id: string): Promise<ResolvedRepository> {
    const row = await this.baseQuery()
      .where('r.id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Repository not found');
    await this.acl.assert(user, 'job', row.job_id, 'manage');

    if (row.target_id == null) {
      throw new BadRequestException(
        'Local filesystem repositories cannot be used remotely; only repositories on a shared connection are reachable from the CLI',
      );
    }

    const resolved = await this.targets.resolveForJob({
      target_id: row.target_id,
      repo_config: row.repo_config as Record<string, unknown>,
      repo_password_secret_id: row.repo_password_secret_id,
      credential_secret_id: row.credential_secret_id,
    });
    return {
      repository: resolved.repository,
      password: resolved.password,
      env: resolved.env,
      credentialFiles: resolved.credentialFiles,
      extraArgs: resolved.extraArgs,
    };
  }
}
