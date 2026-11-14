import { chain, ChainBuilder, createDbMock } from '../testing/db-mock';
import { recordingDb } from '../testing/recording-db';
import { ProxmoxService } from './proxmox.service';
import { AccessControlService } from '../common/access-control.service';
import { ResticService } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';
import { JobsService } from '../jobs/jobs.service';
import { RunRetryService } from '../jobs/run-retry.service';
import { PruneRunnerService } from '../jobs/prune-runner.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { AGENT_LOST_TASK_MESSAGE } from '../agents/run-lease';

const RUN = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const PVE_ID = 'ab'.repeat(32);
const info = { clusterId: PVE_ID, clusterName: 'prod', node: 'pve1', pveVersion: '8.2.4' };

function byTable(map: Record<string, ChainBuilder>) {
  return (table: string) => map[table.split(' ')[0]] ?? chain();
}

function make(db: ReturnType<typeof createDbMock>['db']) {
  const retries = { finalize: jest.fn(async () => undefined) };
  const pruneRunner = { record: jest.fn(async () => 'prune-1') };
  const repositories = { recordStats: jest.fn(async () => ({})), refreshStatsInBackground: jest.fn() };
  const jobs = {
    getRow: jest.fn(async () => ({
      id: 'job-1',
      name: 'Cluster backup',
      proxmox_config: { allGuests: true, vmids: [], parallelPerNode: 1 },
      restic_options: { compression: 'max', timeLimitSeconds: 1800, retention: { keepDaily: 7 } },
    })),
  };
  const targets = {
    resolveForJob: jest.fn(async () => ({ repository: 's3:bucket/repo', password: 'pw', env: {}, credentialFiles: [] })),
  };
  const service = new ProxmoxService(
    db,
    {} as AccessControlService,
    {} as ResticService,
    targets as unknown as TargetsService,
    jobs as unknown as JobsService,
    retries as unknown as RunRetryService,
    pruneRunner as unknown as PruneRunnerService,
    repositories as unknown as RepositoriesService,
  );
  return { service, retries, pruneRunner, repositories, jobs };
}

afterEach(() => {
  delete process.env.RUN_QUEUE_TIMEOUT_SECONDS;
});

describe('ProxmoxService — queued guests wait while their node agent is online', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  function sweepWith(item: { node: string; queued_at: Date }, agents: unknown[]) {
    const itemUpdate = chain({ execute: [] });
    const { db } = createDbMock({
      selectFrom: byTable({
        proxmox_run_items: chain({
          execute: [{ id: ITEM, run_id: RUN, pve_cluster_id: PVE_ID, ...item }],
        }),
        agents: chain({ execute: agents }),
        job_runs: chain({ execute: [] }),
      }),
      updateTable: byTable({ proxmox_run_items: itemUpdate }),
    });
    const { service } = make(db);
    return { service, itemUpdate };
  }

  const failedWith = (update: ChainBuilder) =>
    update.set.mock.calls
      .map((c) => c[0] as { status?: string; error?: string })
      .filter((p) => p.status === 'failed' && !p.error?.includes('stopped reporting'));

  it('never times out a guest that waits for a free slot on a node whose agent is online', async () => {
    const { service, itemUpdate } = sweepWith({ node: 'pve1', queued_at: minutesAgo(2 * 24 * 60) }, [
      { id: 'agent-1', name: 'pve1', status: 'online', last_seen_at: new Date(), poll_interval_seconds: 30, proxmox_info: info },
    ]);

    await service.sweep();

    expect(failedWith(itemUpdate)).toEqual([]);
  });

  it('fails a waiting guest once its node agent has been offline for the queue timeout', async () => {
    const { service, itemUpdate } = sweepWith({ node: 'pve1', queued_at: minutesAgo(120) }, [
      { id: 'agent-1', name: 'pve1', status: 'offline', last_seen_at: minutesAgo(60), poll_interval_seconds: 30, proxmox_info: info },
    ]);

    await service.sweep();

    expect(failedWith(itemUpdate)).toEqual([
      expect.objectContaining({ error: expect.stringContaining('the agent on node pve1 has been offline') }),
    ]);
  });

  it('counts from when the guest became claimable (e.g. after it moved)', async () => {
    const { service, itemUpdate } = sweepWith({ node: 'pve1', queued_at: minutesAgo(1) }, [
      { id: 'agent-1', name: 'pve1', status: 'offline', last_seen_at: minutesAgo(60), poll_interval_seconds: 30, proxmox_info: info },
    ]);

    await service.sweep();

    expect(failedWith(itemUpdate)).toEqual([]);
  });

  it('gives an offline agent with a long poll interval two intervals plus a minute', async () => {
    const { service, itemUpdate } = sweepWith({ node: 'pve1', queued_at: minutesAgo(60) }, [
      { id: 'agent-1', name: 'pve1', status: 'offline', last_seen_at: minutesAgo(15), poll_interval_seconds: 600, proxmox_info: info },
    ]);

    await service.sweep();

    // 15 min < 2 × 10 min + 1 min.
    expect(failedWith(itemUpdate)).toEqual([]);
  });

  it('fails a waiting guest on a node without any agent', async () => {
    const { service, itemUpdate } = sweepWith({ node: 'pve9', queued_at: minutesAgo(10) }, []);

    await service.sweep();

    expect(failedWith(itemUpdate)).toEqual([
      expect.objectContaining({ error: expect.stringContaining('no Amber agent runs on node pve9') }),
    ]);
  });
});

describe('ProxmoxService — leases', () => {
  it('fails running guests whose agent stopped reporting, relative to the agent', async () => {
    const { db, queries } = recordingDb();
    const { service } = make(db);

    await service.sweep();

    const lease = queries.find((q) => q.sql.startsWith('update "proxmox_run_items"') && q.sql.includes('from "agents"'));
    expect(lease).toBeDefined();
    expect(lease!.sql).toContain('greatest(coalesce("proxmox_run_items"."heartbeat_at", "proxmox_run_items"."started_at")');
    expect(lease!.parameters).toContain('The agent stopped reporting on this task.');
    // The finishing task has a lease too.
    expect(
      queries.some((q) => q.sql.includes('"job_runs"."proxmox_phase" = $2') && q.sql.includes('reports_running_tasks')),
    ).toBe(true);
  });

  it('fails guests and finishes finishing tasks the agent lost', async () => {
    const previousPoll = new Date(Date.now() - 60_000);
    const { db, queries } = recordingDb(({ sql }) => {
      if (sql.startsWith('update "proxmox_run_items"')) return [{ run_id: RUN }];
      if (sql.startsWith('select "id" from "job_runs"')) return [{ id: RUN }];
      return [];
    });
    const { service } = make(db);

    await service.reconcileAgentTasks('agent-1', [ITEM, 'stats-x'], previousPoll);

    expect(queries[0].sql).toBe(
      'update "proxmox_run_items" set "status" = $1, "finished_at" = $2, "error" = $3, "progress" = $4 where "agent_id" = $5 and "status" = $6 and "started_at" < $7 and "id" not in ($8) returning "run_id"',
    );
    expect(queries[0].parameters).toEqual(['failed', expect.any(Date), AGENT_LOST_TASK_MESSAGE, null, 'agent-1', 'running', previousPoll, ITEM]);
    const retention = queries.find((q) => q.sql.startsWith('select "id" from "job_runs"'))!;
    expect(retention.sql).toContain('"proxmox_phase" = $3 and "proxmox_phase_at" < $4');
    expect(retention.sql).not.toContain('not in');
    // The run is finished without its retention.
    expect(
      queries.some(
        (q) => q.sql.startsWith('update "job_runs"') && q.parameters.includes('done') && q.sql.includes('"log"'),
      ),
    ).toBe(true);
  });

  it('renews guests and finishing tasks the poll lists', async () => {
    const { db, queries } = recordingDb();
    const { service } = make(db);

    await service.renewAgentTasks('agent-1', [ITEM, `pveret-${RUN}`], new Date());

    expect(queries.map((q) => q.sql)).toEqual([
      'update "proxmox_run_items" set "heartbeat_at" = $1 where "agent_id" = $2 and "status" = $3 and "id" in ($4)',
      'update "job_runs" set "heartbeat_at" = $1 where "agent_id" = $2 and "status" = $3 and "proxmox_phase" = $4 and "id" in ($5)',
    ]);
    expect(queries[0].parameters).toContain(ITEM);
    expect(queries[1].parameters).toContain(RUN);
  });

  it('renews a running guest on its task-state check', async () => {
    const itemUpdate = chain({ execute: [] });
    const { db } = createDbMock({
      selectFrom: byTable({
        proxmox_run_items: chain({ executeTakeFirst: { status: 'running', agent_id: 'agent-1', run_status: 'running' } }),
      }),
      updateTable: byTable({ proxmox_run_items: itemUpdate }),
    });
    const { service } = make(db);

    expect(await service.taskState('agent-1', ITEM)).toEqual({ cancelled: false });
    expect(itemUpdate.set).toHaveBeenCalledWith({ heartbeat_at: expect.any(Date) });
  });
});

describe('ProxmoxService — idempotent finishing task and time limit', () => {
  it('acknowledges a repeated finishing-task result without recording the prune again', async () => {
    const { db } = createDbMock({
      selectFrom: byTable({
        job_runs: chain({
          executeTakeFirst: {
            id: RUN,
            job_id: 'job-1',
            trigger: 'schedule',
            agent_id: 'agent-1',
            proxmox_phase: 'done',
            repository_id: 'repo-1',
          },
        }),
      }),
    });
    const { service, pruneRunner, repositories, retries } = make(db);

    await service.recordRetention('agent-1', RUN, {
      status: 'success',
      repoStats: { sizeBytes: 1, snapshotCount: 1 },
      prune: { status: 'success', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
    });

    expect(pruneRunner.record).not.toHaveBeenCalled();
    expect(repositories.recordStats).not.toHaveBeenCalled();
    expect(retries.finalize).not.toHaveBeenCalled();
  });

  it("hands the job's time limit to the agent with each guest", async () => {
    const itemUpdate = chain({
      executeTakeFirst: { id: ITEM, job_id: 'job-1', vmid: 100, guest_type: 'qemu', name: 'web', node: 'pve1' },
    });
    const queued = chain();
    queued.execute
      .mockResolvedValueOnce([{ id: ITEM, job_id: 'job-1', proxmox_config: { allGuests: true, vmids: [] } }])
      .mockResolvedValue([]);
    const { db } = createDbMock({
      selectFrom: byTable({
        proxmox_clusters: chain({
          executeTakeFirst: {
            id: 'cluster-1',
            slug: 'prod',
            pve_cluster_id: PVE_ID,
            primary_agent_id: 'agent-2',
            inventory: null,
            inventory_at: new Date(),
          },
        }),
        proxmox_run_items: queued,
        job_runs: chain({ execute: [] }),
        proxmox_job_guests: chain({ execute: [] }),
      }),
      updateTable: byTable({ proxmox_run_items: itemUpdate }),
    });
    const { service } = make(db);

    const tasks = await service.claimTasks('agent-1', info);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].options).toEqual({ compression: 'max', timeLimitSeconds: 1800 });
    expect(itemUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ heartbeat_at: expect.any(Date) }));
  });
});
