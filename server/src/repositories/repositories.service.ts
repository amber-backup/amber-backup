import {
  BadRequestException,
  Inject,
  Injectable,
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
  /** The (1:1) backup job that owns this repository. */
  job_id: string;
  job_name: string;
  location: string;
  created_at: Date;
  updated_at: Date;
}

/** Detail shape adds live figures obtained from restic on demand. */
export interface RepositoryDetail extends PublicRepository {
  /** Deduplicated repository size in bytes; null if restic was unreachable. */
  size_bytes: number | null;
  snapshot_count: number | null;
  /** Present only when the live figures could not be fetched. */
  stats_error?: string;
}

@Injectable()
export class RepositoriesService {
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

    const detail: RepositoryDetail = {
      ...this.toPublic(row),
      size_bytes: null,
      snapshot_count: null,
    };

    // Size and snapshot count are read live from restic. A repository may be
    // unreachable (offline backend, wrong credentials) — degrade gracefully
    // rather than failing the whole request.
    try {
      const ctx = await this.targets.resolveForJob({
        target_id: row.target_id,
        repo_config: row.repo_config as Record<string, unknown>,
        repo_password_secret_id: row.repo_password_secret_id,
      });
      const [snaps, stats] = await Promise.all([
        this.restic.snapshots(ctx),
        this.restic.stats(ctx),
      ]);
      detail.snapshot_count = snaps.length;
      detail.size_bytes = stats.total_size ?? null;
    } catch (e) {
      detail.stats_error = (e as Error).message;
    }
    return detail;
  }

  /**
   * Resolves the decrypted credentials needed to run restic directly against a
   * repository (the `ambb repo use` CLI wrapper). Requires `operate` on the
   * owning job — the same level as running the job — because it exposes the repo
   * password and backend credentials to the caller.
   *
   * Only repositories on a shared connection can be reached from another host; a
   * local filesystem repository lives on the server and is rejected.
   */
  async resolve(user: RequestUser, id: string): Promise<ResolvedRepository> {
    const row = await this.baseQuery()
      .where('r.id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Repository not found');
    await this.acl.assert(user, 'job', row.job_id, 'operate');

    if (row.target_id == null) {
      throw new BadRequestException(
        'Local filesystem repositories cannot be used remotely; only repositories on a shared connection are reachable from the CLI',
      );
    }

    const resolved = await this.targets.resolveForJob({
      target_id: row.target_id,
      repo_config: row.repo_config as Record<string, unknown>,
      repo_password_secret_id: row.repo_password_secret_id,
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
