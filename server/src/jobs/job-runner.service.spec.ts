import { chain, createDbMock } from '../testing/db-mock';
import { recordingDb } from '../testing/recording-db';
import { JobRunnerService } from './job-runner.service';
import { ResticService } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';
import { RunRetryService } from './run-retry.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { PruneRunnerService } from './prune-runner.service';

describe('JobRunnerService', () => {
  function make(staleIds: string[]) {
    const update = chain({ execute: staleIds.map((id) => ({ id })) });
    const { db } = createDbMock({ updateTable: update });
    const retries = { finalize: jest.fn().mockResolvedValue(undefined) };
    const service = new JobRunnerService(
      db,
      {} as ResticService,
      {} as TargetsService,
      retries as unknown as RunRetryService,
      {} as RepositoriesService,
      {} as PruneRunnerService,
    );
    return { service, update, retries, db };
  }

  afterEach(() => {
    delete process.env.RUN_QUEUE_TIMEOUT_SECONDS;
  });

  /** The service on a recording database (real SQL, scripted rows). */
  function makeRecorded(respond: Parameters<typeof recordingDb>[0]) {
    const { db, queries } = recordingDb(respond);
    const retries = { finalize: jest.fn().mockResolvedValue(undefined) };
    const service = new JobRunnerService(
      db,
      {} as ResticService,
      {} as TargetsService,
      retries as unknown as RunRetryService,
      {} as RepositoriesService,
      {} as PruneRunnerService,
    );
    return { service, queries, retries };
  }

  describe('failStaleQueuedRuns', () => {
    it('fails queued backups and checks older than the timeout and settles each', async () => {
      process.env.RUN_QUEUE_TIMEOUT_SECONDS = '300';
      const { service, queries, retries } = makeRecorded(({ sql }) =>
        sql.startsWith('select')
          ? [
              { id: 'r1', kind: 'backup', wait_seconds: 300 },
              { id: 'r2', kind: 'check', wait_seconds: 1260 },
            ]
          : [{ id: 'x' }],
      );

      await service.failStaleQueuedRuns();

      const [select, ...updates] = queries;
      // The wait is relative to the agent: at least two poll intervals + 60 s.
      expect(select.sql).toContain('left join "agents" on "agents"."id" = "backup_jobs"."agent_id"');
      expect(select.sql).toContain(
        'greatest($1::int, coalesce(2 * "agents"."poll_interval_seconds" + 60, 0)) as "wait_seconds"',
      );
      // A pending retry counts from when it became due, not from when it was queued.
      expect(select.sql).toContain('coalesce(job_runs.not_before, job_runs.created_at) <');
      expect(select.parameters).toContain(300);
      expect(updates).toHaveLength(2);
      expect(updates[0].parameters).toContain('Not picked up within 5 min — is the agent offline?');
      expect(updates[1].parameters).toContain(
        'Not picked up within 21 min — is the agent offline or too old for integrity checks?',
      );
      // Only a run still queued is failed (it may have been claimed meanwhile).
      expect(updates[0].sql).toContain('"status" = $');
      expect(updates[0].parameters).toContain('queued');
      expect(retries.finalize).toHaveBeenCalledWith('r1');
      expect(retries.finalize).toHaveBeenCalledWith('r2');
    });

    it('leaves a run alone that was claimed in the meantime', async () => {
      process.env.RUN_QUEUE_TIMEOUT_SECONDS = '300';
      const { service, retries } = makeRecorded(({ sql }) =>
        sql.startsWith('select') ? [{ id: 'r1', kind: 'backup', wait_seconds: 300 }] : [],
      );

      await service.failStaleQueuedRuns();

      expect(retries.finalize).not.toHaveBeenCalled();
    });

    it('does nothing when the timeout is disabled', async () => {
      process.env.RUN_QUEUE_TIMEOUT_SECONDS = '0';
      const { service, queries, retries } = makeRecorded(() => [{ id: 'r1' }]);

      await service.failStaleQueuedRuns();

      expect(queries).toHaveLength(0);
      expect(retries.finalize).not.toHaveBeenCalled();
    });
  });

  describe('failInterruptedRuns (startup)', () => {
    it('fails local activities a restart cut off and returns those to settle', async () => {
      const { service, queries } = makeRecorded(({ sql }) =>
        sql.startsWith('update "job_runs"')
          ? [
              { id: 'b1', kind: 'backup' },
              { id: 'p1', kind: 'prune' },
              { id: 'c1', kind: 'check' },
            ]
          : [{ id: 'rs1' }],
      );

      const toSettle = await service.failInterruptedRuns();

      expect(toSettle).toEqual(['b1', 'c1']);
      const [runs, restores] = queries;
      // Only what this server ran itself: agent runs have their agent_id.
      expect(runs.sql).toBe(
        'update "job_runs" set "status" = $1, "finished_at" = $2, "error" = $3 where "status" = $4 and "agent_id" is null returning "id", "kind"',
      );
      expect(runs.parameters).toEqual(['failed', expect.any(Date), 'Interrupted by a server restart.', 'running']);
      expect(restores.sql).toContain('update "restore_runs"');
      expect(restores.sql).toContain('"agent_id" is null');
      expect(restores.parameters).toEqual(
        expect.arrayContaining(['Interrupted by a server restart.', 'queued', 'running']),
      );
    });

    it('settles them through the retry service', async () => {
      const { service, retries } = makeRecorded(() => []);

      await service.finalizeInterrupted(['b1', 'c1']);

      expect(retries.finalize).toHaveBeenCalledWith('b1');
      expect(retries.finalize).toHaveBeenCalledWith('c1');
    });
  });

  describe('executeLocal on shutdown', () => {
    it('leaves a run cut off by the shutdown running for the next start', async () => {
      const select = chain({
        executeTakeFirst: {
          run_id: 'run-1',
          trigger: 'manual',
          job_id: 'job-1',
          job_name: 'Job',
          repository_id: 'repo-1',
          target_id: null,
          repo_config: {},
          repo_password_secret_id: 's',
          credential_secret_id: null,
          restic_options: {},
          location: 'local',
          paths: ['/data'],
        },
      });
      const update = chain({ execute: [] });
      const { db } = createDbMock({ selectFrom: select, updateTable: update });
      const retries = { finalize: jest.fn().mockResolvedValue(undefined) };
      let started!: () => void;
      const running = new Promise<void>((r) => (started = r));
      const restic = {
        ensureInitialized: jest.fn().mockResolvedValue(undefined),
        backup: jest.fn(
          (_ctx: unknown, _paths: unknown, _opts: unknown, _cb: unknown, signal: AbortSignal) =>
            new Promise((_resolve, reject) => {
              started();
              signal.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        ),
      };
      const targets = {
        resolveForJob: jest.fn().mockResolvedValue({
          repository: '/repo',
          password: 'pw',
          env: {},
          credentialFiles: [],
        }),
      };
      const service = new JobRunnerService(
        db,
        restic as unknown as ResticService,
        targets as unknown as TargetsService,
        retries as unknown as RunRetryService,
        {} as RepositoriesService,
        {} as PruneRunnerService,
      );

      const run = service.executeLocal('run-1');
      await running;
      service.onApplicationShutdown();
      await run;

      const statuses = update.set.mock.calls.map((c) => (c[0] as { status?: string }).status);
      expect(statuses).toEqual(['running']);
      expect(retries.finalize).not.toHaveBeenCalled();
    });
  });

  describe('startDueRetries', () => {
    it('claims due local retries by clearing not_before and dispatches each', async () => {
      const { service, update } = make(['r1', 'r2']);
      const dispatch = jest.spyOn(service, 'dispatch').mockResolvedValue(undefined);

      await service.startDueRetries();

      expect(update.set).toHaveBeenCalledWith({ not_before: null });
      expect(update.where).toHaveBeenCalledWith('status', '=', 'queued');
      expect(update.where).toHaveBeenCalledWith('not_before', '<=', expect.any(Date));
      expect(dispatch).toHaveBeenCalledWith('r1');
      expect(dispatch).toHaveBeenCalledWith('r2');
    });
  });
});
