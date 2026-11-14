import { chain, ChainBuilder, createDbMock, TEST_MASTER_KEY } from '../testing/db-mock';
import { recordingDb } from '../testing/recording-db';

process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;

import { CryptoService } from '../crypto/crypto.service';
import { AgentsService } from './agents.service';
import { TargetsService } from '../targets/targets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { PruneRunnerService } from '../jobs/prune-runner.service';
import { CheckRunnerService } from '../jobs/check-runner.service';
import { RunRetryService } from '../jobs/run-retry.service';
import { RunLeaseService } from './run-lease.service';
import { LEASE_EXPIRED_MESSAGES, RESTORE_NOT_PICKED_UP_MESSAGE } from './run-lease';

const RUN = '0b6f4a52-1c3e-4d5f-8a9b-0c1d2e3f4a5b';
const agent = { id: 'agent-1' } as never;
const resolvedRepo = { repository: 's3:bucket/repo', password: 'pw', env: {}, credentialFiles: [] };

/** Builders by table name. */
function byTable(map: Record<string, ChainBuilder>, fallback: ChainBuilder = chain()) {
  return (table: string) => map[table.split(' ')[0]] ?? fallback;
}

function make(opts: {
  select?: ChainBuilder | ((t: string) => ChainBuilder);
  update?: ChainBuilder | ((t: string) => ChainBuilder);
  targets?: Partial<Record<keyof TargetsService, jest.Mock>>;
  repos?: Record<string, jest.Mock>;
  leases?: Partial<Record<keyof RunLeaseService, jest.Mock>>;
}) {
  const { db } = createDbMock({
    selectFrom: opts.select ?? chain({ execute: [] }),
    updateTable: opts.update ?? chain({ execute: [], executeTakeFirst: { poll_interval_seconds: 30 } }),
    insertInto: chain({ execute: [] }),
  });
  const retries = { finalize: jest.fn().mockResolvedValue(undefined) };
  const repos = {
    claimStatsRequests: jest.fn().mockResolvedValue([]),
    recordStats: jest.fn().mockResolvedValue(undefined),
    refreshStatsInBackground: jest.fn(),
    ...opts.repos,
  };
  const prune = { record: jest.fn().mockResolvedValue('prune-1') };
  const service = new AgentsService(
    db,
    new CryptoService(),
    (opts.targets ?? {}) as unknown as TargetsService,
    {} as NotificationsService,
    repos as unknown as RepositoriesService,
    prune as unknown as PruneRunnerService,
    {} as CheckRunnerService,
    retries as unknown as RunRetryService,
    undefined,
    undefined,
    opts.leases as unknown as RunLeaseService | undefined,
  );
  return { service, retries, repos, prune };
}

describe('AgentsService — poll and the task list (lease)', () => {
  it('hands the agent its task list and previous poll time for reconciliation', async () => {
    const lastPoll = new Date(Date.now() - 30_000);
    const update = chain({ execute: [], executeTakeFirst: { poll_interval_seconds: 30 } });
    const leases = { reconcile: jest.fn().mockResolvedValue(undefined) };
    const { service } = make({
      select: chain({ execute: [], executeTakeFirst: { last_poll_at: lastPoll } }),
      update,
      leases,
    });

    await service.poll(agent, { runningTaskIds: [RUN] });

    expect(leases.reconcile).toHaveBeenCalledWith('agent-1', [RUN], lastPoll);
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({ last_poll_at: expect.any(Date), reports_running_tasks: true }),
    );
  });

  it('does not reconcile for an older agent that sends no task list', async () => {
    const update = chain({ execute: [], executeTakeFirst: { poll_interval_seconds: 30 } });
    const leases = { reconcile: jest.fn().mockResolvedValue(undefined) };
    const { service } = make({ update, leases });

    await service.poll(agent, {});

    expect(leases.reconcile).not.toHaveBeenCalled();
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ reports_running_tasks: false }));
  });

  it('treats a null task list (a nil Go slice) as an empty one', async () => {
    const lastPoll = new Date(Date.now() - 30_000);
    const update = chain({ execute: [], executeTakeFirst: { poll_interval_seconds: 30 } });
    const leases = { reconcile: jest.fn().mockResolvedValue(undefined) };
    const { service } = make({
      select: chain({ execute: [], executeTakeFirst: { last_poll_at: lastPoll } }),
      update,
      leases,
    });

    await service.poll(agent, { runningTaskIds: null });

    expect(leases.reconcile).toHaveBeenCalledWith('agent-1', [], lastPoll);
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ reports_running_tasks: true }));
  });

  it('still answers the poll when reconciling fails', async () => {
    const leases = { reconcile: jest.fn().mockRejectedValue(new Error('db hiccup')) };
    const { service } = make({ leases });

    await expect(service.poll(agent, { runningTaskIds: [] })).resolves.toEqual(
      expect.objectContaining({ tasks: [] }),
    );
  });
});

describe('AgentsService — claim loops', () => {
  const backupRow = (id: string) => ({
    run_id: id,
    job_id: 'job-1',
    job_name: 'Job',
    target_id: null,
    repo_config: {},
    repo_password_secret_id: 's',
    credential_secret_id: null,
    restic_options: { timeLimitSeconds: 3600, compression: 'max' },
    paths: ['/data'],
    source_kind: 'files',
    hyperv_host_id: null,
    hyperv_config: null,
  });

  it('fails only the run whose task cannot be prepared and hands out the others', async () => {
    const update = chain({ execute: [], executeTakeFirst: { id: 'x', poll_interval_seconds: 30 } });
    const resolveForJob = jest
      .fn()
      .mockRejectedValueOnce(new Error('cannot decrypt the repository password'))
      .mockResolvedValue(resolvedRepo);
    const { service, retries } = make({
      select: byTable({ job_runs: chain({ execute: [backupRow('run-1'), backupRow('run-2')] }) }, chain({ execute: [] })),
      update,
      targets: { resolveForJob },
    });

    const { tasks } = await service.poll(agent, {});

    expect(tasks.map((t) => t.taskId)).toEqual(['run-2']);
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'Preparing the task failed: cannot decrypt the repository password',
      }),
    );
    expect(retries.finalize).toHaveBeenCalledWith('run-1');
    // The claim starts the lease.
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'running', heartbeat_at: expect.any(Date) }),
    );
  });

  it("passes the job's time limit on to the agent", async () => {
    const { service } = make({
      select: byTable({ job_runs: chain({ execute: [backupRow('run-1')] }) }, chain({ execute: [] })),
      update: chain({ execute: [], executeTakeFirst: { id: 'x', poll_interval_seconds: 30 } }),
      targets: { resolveForJob: jest.fn().mockResolvedValue(resolvedRepo) },
    });

    const { tasks } = await service.poll(agent, {});

    expect(tasks[0].options).toEqual({ timeLimitSeconds: 3600, compression: 'max' });
  });

  it('answers the poll even when a whole kind of task fails', async () => {
    const { service } = make({
      repos: { claimStatsRequests: jest.fn().mockRejectedValue(new Error('boom')) },
    });

    await expect(service.poll(agent, { capabilities: ['stats'] })).resolves.toEqual(
      expect.objectContaining({ tasks: [] }),
    );
  });

  it('discards a restore that waited too long instead of running it now', async () => {
    const update = chain({ execute: [], executeTakeFirst: { id: 'x', poll_interval_seconds: 30 } });
    const resolveForRestore = jest.fn();
    const { service } = make({
      select: byTable(
        {
          restore_runs: chain({
            execute: [{ id: 'rs-1', created_at: new Date(Date.now() - 2 * 3600_000), mode: 'original' }],
          }),
        },
        chain({ execute: [] }),
      ),
      update,
      targets: { resolveForRestore },
    });

    const { tasks } = await service.poll(agent, {});

    expect(tasks).toEqual([]);
    expect(resolveForRestore).not.toHaveBeenCalled();
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: RESTORE_NOT_PICKED_UP_MESSAGE }),
    );
  });
});

describe('AgentsService — results are idempotent', () => {
  const runRow = { id: RUN, job_id: 'job-1', trigger: 'schedule', repository_id: 'repo-1' };
  const result = {
    status: 'success',
    snapshotId: 'snap-1',
    repoStats: { sizeBytes: 10, snapshotCount: 2 },
    prune: { status: 'success', startedAt: '2026-11-01T10:00:00Z', finishedAt: '2026-11-01T10:01:00Z' },
  } as never;

  it('acknowledges a repeated result without recording or notifying anything again', async () => {
    // The run is no longer running and was not given up on: already settled.
    const update = chain({ execute: [], executeTakeFirst: undefined });
    const { service, retries, repos, prune } = make({
      select: chain({ executeTakeFirst: runRow }),
      update,
    });

    await expect(service.submitBackupResult('agent-1', RUN, result)).resolves.toBeUndefined();

    expect(repos.recordStats).not.toHaveBeenCalled();
    expect(prune.record).not.toHaveBeenCalled();
    expect(retries.finalize).not.toHaveBeenCalled();
  });

  it('takes a late success for a run the server gave up on and drops its now needless retry', async () => {
    const update = chain({ execute: [] });
    update.executeTakeFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: RUN });
    const { service, retries, prune } = make({
      select: chain({ executeTakeFirst: runRow }),
      update,
    });

    await service.submitBackupResult('agent-1', RUN, result);

    expect(update.where).toHaveBeenCalledWith('error', 'in', LEASE_EXPIRED_MESSAGES);
    expect(prune.record).toHaveBeenCalledTimes(1);
    expect(update.where).toHaveBeenCalledWith('retry_of_run_id', '=', RUN);
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled', error: expect.stringContaining('Not needed') }),
    );
    expect(retries.finalize).toHaveBeenCalledWith(RUN);
  });

  it('does not settle a late failure a second time', async () => {
    const update = chain({ execute: [] });
    update.executeTakeFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: RUN });
    const { service, retries } = make({ select: chain({ executeTakeFirst: runRow }), update });

    await service.submitBackupResult('agent-1', RUN, { status: 'failed', error: 'disk full' } as never);

    expect(retries.finalize).not.toHaveBeenCalled();
  });

  it('acknowledges a repeated restore result', async () => {
    const update = chain({ execute: [], executeTakeFirst: undefined });
    const { service } = make({ select: chain({ executeTakeFirst: { id: RUN } }), update });

    await expect(service.submitRestoreResult('agent-1', RUN, { status: 'success' } as never)).resolves.toBeUndefined();
    expect(update.where).toHaveBeenCalledWith('status', '=', 'running');
  });
});

describe('AgentsService — heartbeats', () => {
  it('renews the lease of a running task on its task-state check', async () => {
    const update = chain({ execute: [], executeTakeFirst: { id: RUN } });
    const select = chain({ executeTakeFirst: undefined });
    const { service } = make({ select, update });

    await expect(service.taskState('agent-1', RUN)).resolves.toEqual({ cancelled: false });

    expect(update.set).toHaveBeenCalledWith({ heartbeat_at: expect.any(Date) });
    expect(update.where).toHaveBeenCalledWith('status', '=', 'running');
    // No extra lookup for the usual case.
    expect(select.executeTakeFirst).not.toHaveBeenCalled();
  });

  it('renews the lease on progress', async () => {
    const update = chain({ execute: [] });
    const { service } = make({ update });

    await service.backupProgress('agent-1', RUN, { percentDone: 0.5 });
    await service.restoreProgress('agent-1', RUN, { percentDone: 0.5 });

    expect(update.set).toHaveBeenCalledTimes(2);
    for (const [patch] of update.set.mock.calls) {
      expect(patch).toEqual(expect.objectContaining({ heartbeat_at: expect.any(Date) }));
    }
  });
});

describe('AgentsService — offline detection and the service unit', () => {
  it('waits at least two poll intervals plus a minute before an agent counts as offline', async () => {
    const { db, queries } = recordingDb();
    const service = new AgentsService(
      db,
      new CryptoService(),
      {} as TargetsService,
      {} as NotificationsService,
      {} as RepositoriesService,
      {} as PruneRunnerService,
      {} as CheckRunnerService,
      {} as RunRetryService,
    );

    await service.sweepOffline();

    const sweep = queries.find((q) => q.sql.startsWith('update "agents"'))!;
    expect(sweep.sql).toContain(
      '"last_seen_at" < $3::timestamptz - greatest($4::int, coalesce(2 * "poll_interval_seconds" + 60, 0)) * interval',
    );
    expect(sweep.parameters).toEqual(['offline', 'online', expect.any(Date), 120]);
  });

  it('gives the agent time to stop restic and report on stop, and starts it before PVE guests', () => {
    const { service } = make({});

    const script = service.installScript();

    expect(script).toContain('Before=pve-guests.service');
    expect(script).toContain('KillMode=mixed');
    expect(script).toContain('TimeoutStopSec=60');
  });
});
