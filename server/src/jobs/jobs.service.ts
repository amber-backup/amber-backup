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
import { BackupJob, RunTrigger } from '../database/database.types';
import { splitConfig, requiredJobFields } from '../targets/backend-registry';
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

  async list(user: RequestUser): Promise<BackupJob[]> {
    const ids = await this.acl.visibleResourceIds(user, 'job');
    let q = this.db.selectFrom('backup_jobs').selectAll().orderBy('name', 'asc');
    if (ids !== 'all') {
      if (ids.length === 0) return [];
      q = q.where('id', 'in', ids);
    }
    return q.execute();
  }

  /** All enabled jobs — for the scheduler (bypasses per-user ACL). */
  async listEnabled(): Promise<BackupJob[]> {
    return this.db
      .selectFrom('backup_jobs')
      .selectAll()
      .where('enabled', '=', true)
      .execute();
  }

  async getRow(id: string): Promise<BackupJob> {
    const j = await this.db
      .selectFrom('backup_jobs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!j) throw new NotFoundException('Job not found');
    return j;
  }

  async get(user: RequestUser, id: string): Promise<BackupJob> {
    await this.acl.assert(user, 'job', id, 'view');
    return this.getRow(id);
  }

  async create(user: RequestUser, dto: CreateJobDto): Promise<BackupJob> {
    this.validateCron(dto.cronExpr);
    // The repository lives on a shared connection (target) or locally on the
    // executing host (target_id = null). The user must be able to use the
    // connection; the repo-specific fields (bucket/prefix/path) travel per job.
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

    const row = await this.db
      .insertInto('backup_jobs')
      .values({
        name: dto.name,
        location: dto.location,
        agent_id: dto.location === 'agent' ? dto.agentId! : null,
        paths: JSON.stringify(dto.paths),
        target_id: dto.targetId ?? null,
        repo_config: JSON.stringify(repoConfig),
        repo_password_secret_id: repoPasswordSecretId,
        cron_expr: dto.cronExpr,
        restic_options: JSON.stringify(dto.resticOptions ?? {}),
        notify: JSON.stringify(dto.notify ?? {}),
        enabled: dto.enabled ?? true,
        owner_id: user.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

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
    return row;
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateJobDto,
  ): Promise<BackupJob> {
    await this.acl.assert(user, 'job', id, 'manage');
    if (dto.cronExpr) this.validateCron(dto.cronExpr);
    const job = await this.getRow(id);

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.location !== undefined) patch.location = dto.location;
    if (dto.agentId !== undefined) patch.agent_id = dto.agentId;
    if (dto.location === 'local') patch.agent_id = null;
    if (dto.paths !== undefined) patch.paths = JSON.stringify(dto.paths);
    if (dto.cronExpr !== undefined) patch.cron_expr = dto.cronExpr;
    if (dto.resticOptions !== undefined)
      patch.restic_options = JSON.stringify(dto.resticOptions);
    if (dto.notify !== undefined) patch.notify = JSON.stringify(dto.notify);
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;

    // Repository changes: switching the connection or editing the repo fields
    // re-validates against the (possibly new) backend type.
    if (dto.targetId !== undefined || dto.repoConfig !== undefined) {
      const targetId =
        dto.targetId !== undefined ? dto.targetId : job.target_id;
      const backendType = await this.resolveBackendType(user, targetId);
      const rawRepo = dto.repoConfig ?? this.parseConfig(job.repo_config);
      patch.target_id = targetId ?? null;
      patch.repo_config = JSON.stringify(
        this.buildRepoConfig(backendType, rawRepo),
      );
    }
    if (dto.repoPassword !== undefined) {
      await this.secrets.update(job.repo_password_secret_id, dto.repoPassword);
    }

    return this.db
      .updateTable('backup_jobs')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async remove(user: RequestUser, id: string): Promise<void> {
    await this.acl.assert(user, 'job', id, 'manage');
    const job = await this.getRow(id);
    await this.db.deleteFrom('backup_jobs').where('id', '=', id).execute();
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
