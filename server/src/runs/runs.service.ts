import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Db, KYSELY } from '../database/database.module';
import { AccessControlService } from '../common/access-control.service';
import { RequestUser } from '../common/auth/request-user';
import { JobRunnerService } from '../jobs/job-runner.service';

@Injectable()
export class RunsService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly acl: AccessControlService,
    private readonly runner: JobRunnerService,
  ) {}

  private baseQuery() {
    return this.db
      .selectFrom('job_runs')
      .innerJoin('backup_jobs', 'backup_jobs.id', 'job_runs.job_id')
      .innerJoin('repositories', 'repositories.id', 'backup_jobs.repository_id')
      .select([
        'job_runs.id',
        'job_runs.job_id',
        'job_runs.trigger',
        'job_runs.status',
        'job_runs.agent_id',
        'job_runs.started_at',
        'job_runs.finished_at',
        'job_runs.snapshot_id',
        'job_runs.stats',
        'job_runs.forget_result',
        'job_runs.error',
        'job_runs.created_at',
        'backup_jobs.name as job_name',
        'repositories.target_id',
      ]);
  }

  async list(
    user: RequestUser,
    opts: {
      limit?: number;
      offset?: number;
      jobId?: string;
      status?: string;
    } = {},
  ) {
    const ids = await this.acl.visibleResourceIds(user, 'job');
    let q = this.baseQuery()
      // `id` as a tiebreaker keeps pagination stable across equal timestamps.
      .orderBy('job_runs.created_at', 'desc')
      .orderBy('job_runs.id', 'desc')
      .limit(Math.min(opts.limit ?? 50, 200));
    if (opts.offset && opts.offset > 0) q = q.offset(opts.offset);
    if (ids !== 'all') {
      if (ids.length === 0) return [];
      q = q.where('backup_jobs.id', 'in', ids);
    }
    if (opts.jobId) q = q.where('job_runs.job_id', '=', opts.jobId);
    if (opts.status)
      q = q.where('job_runs.status', '=', opts.status as never);
    return q.execute();
  }

  async get(user: RequestUser, id: string) {
    const run = await this.db
      .selectFrom('job_runs')
      .selectAll('job_runs')
      .where('job_runs.id', '=', id)
      .executeTakeFirst();
    if (!run) throw new NotFoundException('Run not found');
    await this.acl.assert(user, 'job', run.job_id, 'view');
    return run;
  }

  async cancel(user: RequestUser, id: string) {
    const run = await this.get(user, id);
    await this.acl.assert(user, 'job', run.job_id, 'operate');
    const killed = this.runner.cancel(id);
    if (!killed && run.status === 'queued') {
      await this.db
        .updateTable('job_runs')
        .set({ status: 'cancelled', finished_at: new Date() })
        .where('id', '=', id)
        .execute();
    }
    return { cancelled: true };
  }

  /** Aggregate figures for the dashboard, scoped to what the user can see. */
  async dashboard(user: RequestUser) {
    const ids = await this.acl.visibleResourceIds(user, 'job');
    const jobFilter = <T>(q: T): T => {
      if (ids === 'all') return q;
      return (q as any).where('backup_jobs.id', 'in', ids.length ? ids : ['-']);
    };

    const recent = await this.list(user, { limit: 10 });
    const runningCount = recent.filter((r) => r.status === 'running').length;

    const failedRow = await jobFilter(
      this.db
        .selectFrom('job_runs')
        .innerJoin('backup_jobs', 'backup_jobs.id', 'job_runs.job_id')
        .select((eb) => eb.fn.countAll<number>().as('c'))
        .where('job_runs.status', '=', 'failed')
        .where('job_runs.created_at', '>', new Date(Date.now() - 7 * 86400_000)),
    ).executeTakeFirst();

    const successRow = await jobFilter(
      this.db
        .selectFrom('job_runs')
        .innerJoin('backup_jobs', 'backup_jobs.id', 'job_runs.job_id')
        .select((eb) => eb.fn.countAll<number>().as('c'))
        .where('job_runs.status', '=', 'success'),
    ).executeTakeFirst();

    return {
      recent,
      running: runningCount,
      failedLastWeek: Number(failedRow?.c ?? 0),
      successTotal: Number(successRow?.c ?? 0),
    };
  }
}
