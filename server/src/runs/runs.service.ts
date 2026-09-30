import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'kysely';
import { Db, KYSELY } from '../database/database.module';
import {
  CheckInfo,
  RestoreMode,
  RunKind,
  RunTrigger,
} from '../database/database.types';
import { AccessControlService } from '../common/access-control.service';
import { RequestUser } from '../common/auth/request-user';
import {
  CANCELLED_NO_PROCESS_MESSAGE,
  CANCELLED_ON_SERVER_AGENT_MESSAGE,
} from '../common/cancel-messages';
import { JobRunnerService } from '../jobs/job-runner.service';
import { PruneRunnerService } from '../jobs/prune-runner.service';
import { CheckRunnerService } from '../jobs/check-runner.service';

/** What an activity in the feed is: a job run's kind, or a restore. */
export type ActivityKind = RunKind | 'restore';

@Injectable()
export class RunsService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly acl: AccessControlService,
    private readonly runner: JobRunnerService,
    private readonly pruneRunner: PruneRunnerService,
    private readonly checkRunner: CheckRunnerService,
  ) {}

  /** Backups, prunes and checks, in the column shape of the activity feed. */
  private jobRunsQuery() {
    return this.db
      .selectFrom('job_runs')
      .innerJoin('backup_jobs', 'backup_jobs.id', 'job_runs.job_id')
      .innerJoin('repositories', 'repositories.id', 'backup_jobs.repository_id')
      .select((eb) => [
        'job_runs.id',
        eb.ref('job_runs.job_id').$castTo<string | null>().as('job_id'),
        eb.ref('job_runs.kind').$castTo<ActivityKind>().as('kind'),
        'job_runs.parent_run_id',
        'job_runs.check_info',
        'job_runs.trigger',
        'job_runs.status',
        'job_runs.attempt',
        'job_runs.retry_of_run_id',
        'job_runs.not_before',
        'job_runs.agent_id',
        'job_runs.started_at',
        'job_runs.finished_at',
        'job_runs.snapshot_id',
        'job_runs.stats',
        'job_runs.forget_result',
        'job_runs.error',
        'job_runs.created_at',
        eb.ref('backup_jobs.name').$castTo<string | null>().as('job_name'),
        'repositories.target_id',
        sql<RestoreMode | null>`null::text`.as('restore_mode'),
      ]);
  }

  /**
   * Restores in the same shape as job runs, so both share one feed. The job
   * may have been deleted since (left join, null name). Literal nulls are cast
   * to the job-run column types so the union lines up.
   */
  private restoreRunsQuery() {
    return this.db
      .selectFrom('restore_runs')
      .leftJoin('backup_jobs', 'backup_jobs.id', 'restore_runs.job_id')
      .select([
        'restore_runs.id',
        'restore_runs.job_id',
        sql<ActivityKind>`'restore'::text`.as('kind'),
        sql<string | null>`null::uuid`.as('parent_run_id'),
        sql<CheckInfo | null>`null::jsonb`.as('check_info'),
        sql<RunTrigger>`'manual'::text`.as('trigger'),
        'restore_runs.status',
        sql<number>`1`.as('attempt'),
        sql<string | null>`null::uuid`.as('retry_of_run_id'),
        sql<Date | null>`null::timestamptz`.as('not_before'),
        'restore_runs.agent_id',
        'restore_runs.started_at',
        'restore_runs.finished_at',
        'restore_runs.snapshot_id',
        'restore_runs.stats',
        sql<Record<string, unknown> | null>`null::jsonb`.as('forget_result'),
        'restore_runs.error',
        'restore_runs.created_at',
        'backup_jobs.name as job_name',
        'restore_runs.target_id',
        sql<RestoreMode | null>`restore_runs.mode`.as('restore_mode'),
      ]);
  }

  /**
   * The activity feed: backups, prunes, checks and restores, newest first.
   * `kind` takes a comma list (e.g. `backup,restore`); `jobId` and `status`
   * filter every kind. Restores of a deleted job are visible to admins only,
   * as in `RestoreService`.
   */
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
    if (ids !== 'all' && ids.length === 0) return [];

    const kinds = opts.kind
      ?.split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    const jobKinds = kinds?.filter((k) => k !== 'restore') ?? [];
    const withJobRuns = !kinds?.length || jobKinds.length > 0;
    const withRestores = !kinds?.length || kinds.includes('restore');

    // Both sides always take part in the union; a kind filter that rules one
    // out makes it a constant false, which Postgres drops at plan time.
    let jobs = this.jobRunsQuery();
    if (!withJobRuns) jobs = jobs.where(sql<boolean>`false`);
    if (jobKinds.length) jobs = jobs.where('job_runs.kind', 'in', jobKinds as RunKind[]);
    if (ids !== 'all') jobs = jobs.where('backup_jobs.id', 'in', ids);
    if (opts.jobId) jobs = jobs.where('job_runs.job_id', '=', opts.jobId);
    if (opts.status) jobs = jobs.where('job_runs.status', '=', opts.status as never);

    let restores = this.restoreRunsQuery();
    if (!withRestores) restores = restores.where(sql<boolean>`false`);
    // `in` never matches a null job_id, i.e. the restores of a deleted job.
    if (ids !== 'all') restores = restores.where('restore_runs.job_id', 'in', ids);
    if (opts.jobId) restores = restores.where('restore_runs.job_id', '=', opts.jobId);
    if (opts.status)
      restores = restores.where('restore_runs.status', '=', opts.status as never);

    let q = this.db
      .selectFrom(jobs.unionAll(restores).as('activity'))
      .selectAll()
      // `id` as a tiebreaker keeps pagination stable across equal timestamps.
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(Math.min(opts.limit ?? 50, 200));
    if (opts.offset && opts.offset > 0) q = q.offset(opts.offset);
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

    if (
      this.runner.cancel(id) ||
      this.pruneRunner.cancel(id) ||
      this.checkRunner.cancel(id)
    ) {
      return { cancelled: true };
    }

    // No local process to kill: settle the row. A remote run may well carry on
    // its host, so say so rather than implying restic was stopped.
    const error =
      run.status === 'queued'
        ? null
        : run.agent_id
          ? CANCELLED_ON_SERVER_AGENT_MESSAGE
          : CANCELLED_NO_PROCESS_MESSAGE;
    await this.db
      .updateTable('job_runs')
      .set({ status: 'cancelled', finished_at: new Date(), error })
      .where('id', '=', id)
      .execute();
    return { cancelled: true };
  }

  /**
   * Aggregate figures for the dashboard, scoped to what the user can see.
   * `recent` and `running` cover every activity (backups, prunes, checks,
   * restores); the success/failure counters are about backups only.
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
