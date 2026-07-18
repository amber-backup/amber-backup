import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import parser from 'cron-parser';
import { Db, KYSELY } from '../database/database.module';
import { AccessControlService } from '../common/access-control.service';
import { SecretsService } from '../crypto/secrets.service';
import { RequestUser } from '../common/auth/request-user';
import { BackupJobRow, RunTrigger } from '../database/database.types';
import { splitConfig, requiredJobFields } from '../targets/backend-registry';
import { uniqueSlug } from '../common/slug';
import { CreateJobDto, UpdateJobDto } from './dto/job.dto';

@Injectable()
export class JobsService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly acl: AccessControlService,
    private readonly secrets: SecretsService,
  ) {}

  private validateCron(expr: string): void {
    try {
      parser.parseExpression(expr);
    } catch {
      throw new BadRequestException(`Invalid cron expression: ${expr}`);
    }
  }

  private parseConfig(c: unknown): Record<string, unknown> {
    if (c == null) return {};
    return typeof c === 'string'
      ? (JSON.parse(c) as Record<string, unknown>)
      : (c as Record<string, unknown>);
  }

  /**
   * Resolves the backend type for a job's repository. A null/absent target is a
   * local filesystem repository. Also asserts the user may use the connection.
   */
  private async resolveBackendType(
    user: RequestUser,
    targetId: string | null | undefined,
  ): Promise<string> {
    if (!targetId) return 'local';
    await this.acl.assert(user, 'target', targetId, 'view');
    const t = await this.db
      .selectFrom('targets')
      .select('backend_type')
      .where('id', '=', targetId)
      .executeTakeFirst();
    if (!t) throw new BadRequestException('Unknown target');
    return t.backend_type;
  }

  /**
   * A local filesystem repository (no connection) is, for now, only supported
   * when the job runs on the server itself — not when dispatched to an agent.
   */
  private assertRepoAllowed(
    location: 'local' | 'agent',
    targetId: string | null | undefined,
  ): void {
    if (!targetId && location === 'agent') {
      throw new BadRequestException(
        'A local filesystem repository is only supported when the job runs on the server',
      );
    }
  }

  /** Filters the repo form to job-scoped fields and validates required ones. */
  private buildRepoConfig(
    backendType: string,
    values: Record<string, unknown>,
  ): Record<string, unknown> {
    const { config } = splitConfig(backendType, values, 'job');
    for (const name of requiredJobFields(backendType)) {
      if (config[name] === undefined || config[name] === '') {
        throw new BadRequestException(
          `Missing required repository field: ${name}`,
        );
      }
    }
    return config;
  }

  nextRun(expr: string): Date | null {
    try {
      return parser.parseExpression(expr).next().toDate();
    } catch {
      return null;
    }
  }

  /**
   * Base query for reading a job together with its repository's resolution
   * columns. Repositories were extracted into their own table; joining them back
   * here keeps the job read shape (and thus the API/UI) unchanged.
   */
  private jobQuery() {
    return this.db
      .selectFrom('backup_jobs as j')
      .innerJoin('repositories as r', 'r.id', 'j.repository_id')
      .selectAll('j')
      .select([
        'r.target_id as target_id',
        'r.repo_config as repo_config',
        'r.repo_password_secret_id as repo_password_secret_id',
      ]);
  }

  async list(user: RequestUser): Promise<BackupJobRow[]> {
    const ids = await this.acl.visibleResourceIds(user, 'job');
    let q = this.jobQuery().orderBy('j.name', 'asc');
    if (ids !== 'all') {
      if (ids.length === 0) return [];
      q = q.where('j.id', 'in', ids);
    }
    return q.execute();
  }

  /** All enabled jobs — for the scheduler (bypasses per-user ACL). */
  async listEnabled(): Promise<BackupJobRow[]> {
    return this.jobQuery().where('j.enabled', '=', true).execute();
  }

  async getRow(id: string): Promise<BackupJobRow> {
    const j = await this.jobQuery().where('j.id', '=', id).executeTakeFirst();
    if (!j) throw new NotFoundException('Job not found');
    return j;
  }

  async get(user: RequestUser, id: string): Promise<BackupJobRow> {
    await this.acl.assert(user, 'job', id, 'view');
    return this.getRow(id);
  }

  async create(user: RequestUser, dto: CreateJobDto): Promise<BackupJobRow> {
    this.validateCron(dto.cronExpr);
    // The repository lives on a shared connection (target) or locally on the
    // executing host (target_id = null). The user must be able to use the
    // connection; the repo-specific fields (bucket/prefix/path) travel per job.
    this.assertRepoAllowed(dto.location, dto.targetId);
    const backendType = await this.resolveBackendType(user, dto.targetId);
    const repoConfig = this.buildRepoConfig(backendType, dto.repoConfig ?? {});

    if (dto.location === 'agent') {
      if (!dto.agentId) {
        throw new BadRequestException('agentId is required for agent jobs');
      }
      const agent = await this.db
        .selectFrom('agents')
        .select('id')
        .where('id', '=', dto.agentId)
        .executeTakeFirst();
      if (!agent) throw new BadRequestException('Unknown agent');
    }

    const repoPasswordSecretId = await this.secrets.create(
      'repo_password',
      dto.repoPassword,
    );

    // Each entity draws its slug from its own table's namespace.
    const jobSlug = await uniqueSlug(this.db, 'backup_jobs', dto.name);
    const repoSlug = await uniqueSlug(this.db, 'repositories', dto.name);

    // The repository is its own entity (1:1 with the job). Create it first, then
    // point the job at it — both in one transaction so a failed job insert never
    // leaves an orphan repository.
    const row = await this.db.transaction().execute(async (trx) => {
      const repo = await trx
        .insertInto('repositories')
        .values({
          name: dto.name,
          slug: repoSlug,
          target_id: dto.targetId ?? null,
          repo_config: JSON.stringify(repoConfig),
          repo_password_secret_id: repoPasswordSecretId,
          owner_id: user.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      return trx
        .insertInto('backup_jobs')
        .values({
          name: dto.name,
          slug: jobSlug,
          location: dto.location,
          agent_id: dto.location === 'agent' ? dto.agentId! : null,
          paths: JSON.stringify(dto.paths),
          repository_id: repo.id,
          cron_expr: dto.cronExpr,
          restic_options: JSON.stringify(dto.resticOptions ?? {}),
          notify: JSON.stringify(dto.notify ?? {}),
          enabled: dto.enabled ?? true,
          owner_id: user.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    });

    if (!user.isAdmin) {
      await this.db
        .insertInto('resource_grants')
        .values({
          user_id: user.id,
          resource_type: 'job',
          resource_id: row.id,
          access_level: 'manage',
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    return this.getRow(row.id);
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateJobDto,
  ): Promise<BackupJobRow> {
    await this.acl.assert(user, 'job', id, 'manage');
    if (dto.cronExpr) this.validateCron(dto.cronExpr);
    const job = await this.getRow(id);

    // Guard against a local repo on an agent job, considering the effective
    // values after this update (either field may be changing here).
    const effectiveLocation = dto.location ?? job.location;
    const effectiveTargetId =
      dto.targetId !== undefined ? dto.targetId : job.target_id;
    this.assertRepoAllowed(effectiveLocation, effectiveTargetId);

    // Job-scoped columns go on backup_jobs; repository-scoped ones on the linked
    // repository row.
    const jobPatch: Record<string, unknown> = { updated_at: new Date() };
    const repoPatch: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      jobPatch.name = dto.name;
      // The slug follows the name; never user-editable.
      jobPatch.slug = await uniqueSlug(this.db, 'backup_jobs', dto.name, id);
      // Keep the repository's name (and thus slug) in sync with its (1:1) job.
      repoPatch.name = dto.name;
      repoPatch.slug = await uniqueSlug(
        this.db,
        'repositories',
        dto.name,
        job.repository_id,
      );
    }
    if (dto.location !== undefined) jobPatch.location = dto.location;
    if (dto.agentId !== undefined) jobPatch.agent_id = dto.agentId;
    if (dto.location === 'local') jobPatch.agent_id = null;
    if (dto.paths !== undefined) jobPatch.paths = JSON.stringify(dto.paths);
    if (dto.cronExpr !== undefined) jobPatch.cron_expr = dto.cronExpr;
    if (dto.resticOptions !== undefined)
      jobPatch.restic_options = JSON.stringify(dto.resticOptions);
    if (dto.notify !== undefined) jobPatch.notify = JSON.stringify(dto.notify);
    if (dto.enabled !== undefined) jobPatch.enabled = dto.enabled;

    // Repository changes: switching the connection or editing the repo fields
    // re-validates against the (possibly new) backend type.
    if (dto.targetId !== undefined || dto.repoConfig !== undefined) {
      const targetId =
        dto.targetId !== undefined ? dto.targetId : job.target_id;
      const backendType = await this.resolveBackendType(user, targetId);
      const rawRepo = dto.repoConfig ?? this.parseConfig(job.repo_config);
      repoPatch.target_id = targetId ?? null;
      repoPatch.repo_config = JSON.stringify(
        this.buildRepoConfig(backendType, rawRepo),
      );
    }
    if (dto.repoPassword !== undefined) {
      await this.secrets.update(job.repo_password_secret_id, dto.repoPassword);
    }

    await this.db.transaction().execute(async (trx) => {
      if (Object.keys(repoPatch).length > 0) {
        repoPatch.updated_at = new Date();
        await trx
          .updateTable('repositories')
          .set(repoPatch)
          .where('id', '=', job.repository_id)
          .execute();
      }
      await trx
        .updateTable('backup_jobs')
        .set(jobPatch)
        .where('id', '=', id)
        .execute();
    });

    return this.getRow(id);
  }

  async remove(user: RequestUser, id: string): Promise<void> {
    await this.acl.assert(user, 'job', id, 'manage');
    const job = await this.getRow(id);
    // Order matters: the job references the repository, which references the
    // password secret (both ON DELETE RESTRICT).
    await this.db.deleteFrom('backup_jobs').where('id', '=', id).execute();
    await this.db
      .deleteFrom('repositories')
      .where('id', '=', job.repository_id)
      .execute();
    await this.secrets.remove(job.repo_password_secret_id);
  }

  async assertOperate(user: RequestUser, id: string): Promise<void> {
    if (!(await this.acl.can(user, 'job', id, 'operate'))) {
      throw new ForbiddenException('Missing operate access on job');
    }
  }

  /** Creates a queued job_run for a job. Dispatch happens in the runner. */
  async createRun(jobId: string, trigger: RunTrigger): Promise<string> {
    const run = await this.db
      .insertInto('job_runs')
      .values({ job_id: jobId, trigger, status: 'queued' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return run.id;
  }
}
