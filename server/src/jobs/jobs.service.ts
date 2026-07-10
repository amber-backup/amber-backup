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
import { RequestUser } from '../common/auth/request-user';
import { BackupJob, RunTrigger } from '../database/database.types';
import { CreateJobDto, UpdateJobDto } from './dto/job.dto';

@Injectable()
export class JobsService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly acl: AccessControlService,
  ) {}

  private validateCron(expr: string): void {
    try {
      parser.parseExpression(expr);
    } catch {
      throw new BadRequestException(`Invalid cron expression: ${expr}`);
    }
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
    // The user must be able to use the target.
    await this.acl.assert(user, 'target', dto.targetId, 'view');
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

    const row = await this.db
      .insertInto('backup_jobs')
      .values({
        name: dto.name,
        location: dto.location,
        agent_id: dto.location === 'agent' ? dto.agentId! : null,
        paths: JSON.stringify(dto.paths),
        target_id: dto.targetId,
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

    return this.db
      .updateTable('backup_jobs')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async remove(user: RequestUser, id: string): Promise<void> {
    await this.acl.assert(user, 'job', id, 'manage');
    await this.db.deleteFrom('backup_jobs').where('id', '=', id).execute();
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
