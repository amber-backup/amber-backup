import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Db, KYSELY } from '../database/database.module';
import { AccessControlService } from '../common/access-control.service';
import { RequestUser } from '../common/auth/request-user';
import { JobRunnerService } from '../jobs/job-runner.service';
import { PruneRunnerService } from '../jobs/prune-runner.service';

@Injectable()
export class RunsService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly acl: AccessControlService,
    private readonly runner: JobRunnerService,
    private readonly pruneRunner: PruneRunnerService,
  ) {}

  private baseQuery() {
    return this.db
      .selectFrom('job_runs')
      .innerJoin('backup_jobs', 'backup_jobs.id', 'job_runs.job_id')
      .innerJoin('repositories', 'repositories.id', 'backup_jobs.repository_id')
      .select([
        'job_runs.id',
        'job_runs.job_id',
        'job_runs.kind',
        'job_runs.parent_run_id',
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
      kind?: string;
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
    if (opts.kind) q = q.where('job_runs.kind', '=', opts.kind as never);
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

  /**
   * Stops a queued or running activity. When the run belongs to a process this
   * server owns, the runner aborts it and settles the row itself. Otherwise —
   * a queued run, one handed to an agent, or one left `running` by a restart —
   * the row is force-cancelled here so the activity stops hanging in the UI.
   */
  async cancel(user: RequestUser, id: string) {
    const run = await this.get(user, id);
    await this.acl.assert(user, 'job', run.job_id, 'operate');
    if (run.status !== 'queued' && run.status !== 'running') {
      throw new BadRequestException(`Run is already ${run.status}`);
    }

    if (this.runner.cancel(id) || this.pruneRunner.cancel(id)) {
      return { cancelled: true };
    }

    // No local process to kill: settle the row. A remote run may well carry on
    // its host, so say so rather than implying restic was stopped.
    const error =
      run.status === 'queued'
        ? null
        : run.agent_id
          ? 'Cancelled on the server — the agent may still be running this task.'
          : 'Cancelled — no running process found.';
    await this.db
      .updateTable('job_runs')
      .set({ status: 'cancelled', finished_at: new Date(), error })
      .where('id', '=', id)
      .execute();
    return { cancelled: true };
  }

  /**
   * Aggregate figures for the dashboard, scoped to what the user can see.
   * `recent` and `running` cover every activity (backups and prunes); the
   * success/failure counters are about backups only.
   */
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
        .where('job_runs.kind', '=', 'backup')
        .where('job_runs.status', '=', 'failed')
        .where('job_runs.created_at', '>', new Date(Date.now() - 7 * 86400_000)),
    ).executeTakeFirst();

    const successRow = await jobFilter(
      this.db
        .selectFrom('job_runs')
        .innerJoin('backup_jobs', 'backup_jobs.id', 'job_runs.job_id')
        .select((eb) => eb.fn.countAll<number>().as('c'))
        .where('job_runs.kind', '=', 'backup')
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
