import { ConflictException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { chain, ChainBuilder, createDbMock } from '../testing/db-mock';
import { ProxmoxService } from './proxmox.service';
import { AccessControlService } from '../common/access-control.service';
import { ResticService } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';
import { JobsService } from '../jobs/jobs.service';
import { RunRetryService } from '../jobs/run-retry.service';
import { PruneRunnerService } from '../jobs/prune-runner.service';
import { RepositoriesService } from '../repositories/repositories.service';
import type { ProxmoxInventory } from './proxmox.contract';
import { ProxmoxJobConfigDto, ProxmoxRestoreSpecDto } from './dto/proxmox.dto';

const RUN = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const PVE_ID = 'ab'.repeat(32);

const inventory: ProxmoxInventory = {
  clusterName: 'prod',
  pveVersion: 'pve-manager/8.2.4',
  readBy: 'pve1',
  nodes: [
    { name: 'pve1', online: true },
    { name: 'pve2', online: true },
  ],
  storages: [],
  guests: [
    { vmid: 100, type: 'qemu', name: 'web', node: 'pve1', status: 'running', template: false, tags: [], disks: [], autoMethod: 'block', staleSnapshots: [] },
    { vmid: 101, type: 'lxc', name: 'dns', node: 'pve2', status: 'running', template: false, tags: [], disks: [], autoMethod: 'files', staleSnapshots: [] },
  ],
};

const cluster = {
  id: 'cluster-1',
  name: 'Prod',
  slug: 'prod',
  pve_cluster_id: PVE_ID,
  cluster_name: 'prod',
  primary_agent_id: 'agent-1',
  inventory,
  inventory_at: new Date(),
  inventory_error: null,
  inventory_requested_at: null,
  owner_id: 'u-1',
};

const agentPve1 = {
  id: 'agent-1',
  name: 'pve1',
  status: 'online',
  last_seen_at: new Date(),
  proxmox_info: { clusterId: PVE_ID, clusterName: 'prod', node: 'pve1', pveVersion: '8.2.4' },
};
const agentPve2 = { ...agentPve1, id: 'agent-2', name: 'pve2', proxmox_info: { ...agentPve1.proxmox_info, node: 'pve2' } };

/** Builders by table name prefix ("job_runs as r" → "job_runs"). */
function byTable(map: Record<string, ChainBuilder>) {
  return (table: string) => map[table.split(' ')[0]] ?? chain();
}

function make(opts: {
  select?: Record<string, ChainBuilder>;
  update?: Record<string, ChainBuilder>;
  insert?: Record<string, ChainBuilder>;
}) {
  const mock = createDbMock({
    selectFrom: byTable(opts.select ?? {}),
    updateTable: byTable(opts.update ?? {}),
    insertInto: byTable(opts.insert ?? {}),
  });
  const retries = { finalize: jest.fn(async () => undefined) };
  const pruneRunner = { record: jest.fn(async () => 'prune-1') };
  const repositories = { recordStats: jest.fn(async () => ({})), refreshStatsInBackground: jest.fn() };
  const jobs = {
    getRow: jest.fn(async () => ({
      id: 'job-1',
      name: 'Cluster backup',
      proxmox_config: { allGuests: true, vmids: [], parallelPerNode: 1 },
      restic_options: { compression: 'max', retention: { keepDaily: 7 } },
    })),
  };
  const targets = {
    resolveForJob: jest.fn(async () => ({
      repository: 's3:bucket/repo',
      password: 'pw',
      env: {},
      credentialFiles: [],
    })),
  };
  const service = new ProxmoxService(
    mock.db,
    {} as AccessControlService,
    {} as ResticService,
    targets as unknown as TargetsService,
    jobs as unknown as JobsService,
    retries as unknown as RunRetryService,
    pruneRunner as unknown as PruneRunnerService,
    repositories as unknown as RepositoriesService,
  );
  return { service, mock, retries, pruneRunner, repositories };
}

describe('ProxmoxService — run expansion', () => {
  const queuedRun = {
    run_id: RUN,
    created_at: new Date(),
    not_before: null,
    retry_of_run_id: null,
    job_id: 'job-1',
    proxmox_cluster_id: 'cluster-1',
    proxmox_config: { allGuests: true, vmids: [] },
  };

  it('splits a run into one item per guest and fails guests on nodes without an agent', async () => {
    const items = chain({ execute: [{ vmid: 100, name: 'web', status: 'queued', result: null, error: null }] });
    const insert = chain();
    const runUpdate = chain({ executeTakeFirst: { id: RUN } });
    const { service } = make({
      select: {
        job_runs: chain({ execute: [queuedRun] }),
        proxmox_clusters: chain({ executeTakeFirst: cluster }),
        agents: chain({ execute: [agentPve1] }),
        proxmox_run_items: items,
      },
      update: { job_runs: runUpdate },
      insert: { proxmox_run_items: insert },
    });

    await service.expandQueuedRuns();

    expect(runUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'running', agent_id: 'agent-1', proxmox_phase: 'items' }),
    );
    const rows = insert.values.mock.calls[0][0];
    expect(rows).toEqual([
      expect.objectContaining({ vmid: 100, node: 'pve1', status: 'queued', guest_type: 'qemu' }),
      expect.objectContaining({
        vmid: 101,
        node: 'pve2',
        status: 'failed',
        error: 'No Amber agent on node pve2',
      }),
    ]);
  });

  it('asks for a fresh inventory and waits while the cached one is stale', async () => {
    const clusterUpdate = chain();
    const runUpdate = chain({ executeTakeFirst: { id: RUN } });
    const { service } = make({
      select: {
        job_runs: chain({ execute: [queuedRun] }),
        proxmox_clusters: chain({
          executeTakeFirst: { ...cluster, inventory_at: new Date(Date.now() - 3600_000) },
        }),
      },
      update: { proxmox_clusters: clusterUpdate, job_runs: runUpdate },
    });

    await service.expandQueuedRuns();

    expect(clusterUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ inventory_requested_at: expect.any(Date) }),
    );
    expect(runUpdate.set).not.toHaveBeenCalled();
  });

  it('repeats only the failed guests in a retry run', async () => {
    const items = chain({
      execute: [
        { vmid: 100, status: 'success' },
        { vmid: 101, status: 'failed' },
      ],
    });
    const insert = chain();
    const { service } = make({
      select: {
        job_runs: chain({ execute: [{ ...queuedRun, retry_of_run_id: 'run-0' }] }),
        proxmox_clusters: chain({ executeTakeFirst: cluster }),
        agents: chain({ execute: [agentPve1, agentPve2] }),
        proxmox_run_items: items,
      },
      update: { job_runs: chain({ executeTakeFirst: { id: RUN } }) },
      insert: { proxmox_run_items: insert },
    });

    await service.expandQueuedRuns();

    const rows = insert.values.mock.calls[0][0];
    expect(rows.map((r: { vmid: number }) => r.vmid)).toEqual([101]);
  });
});

/** claimItems reads the queued items first, then the running ones (none here). */
function queuedThenNoneRunning(queued: unknown[]): ChainBuilder {
  const items = chain();
  items.execute.mockResolvedValueOnce(queued).mockResolvedValue([]);
  return items;
}

describe('ProxmoxService — dispatch', () => {
  it('hands the primary agent the inventory and its node its due guests within the caps', async () => {
    const itemUpdate = chain({
      executeTakeFirst: { id: ITEM, job_id: 'job-1', vmid: 100, guest_type: 'qemu', name: 'web', node: 'pve1' },
    });
    const { service } = make({
      select: {
        proxmox_clusters: chain({ executeTakeFirst: { ...cluster, inventory_requested_at: new Date() } }),
        // queued items of pve1 (claimItems), then none running — and nothing else in job_runs.
        proxmox_run_items: queuedThenNoneRunning([
          { id: ITEM, job_id: 'job-1', proxmox_config: { allGuests: true, vmids: [], parallelPerNode: 1 } },
          { id: 'item-2', job_id: 'job-1', proxmox_config: { allGuests: true, vmids: [], parallelPerNode: 1 } },
        ]),
        job_runs: chain({ execute: [] }),
        proxmox_job_guests: chain({
          executeTakeFirst: { last_snapshot_id: 'snap-0', cbt: { bitmap: 'amber-1', node: 'pve1', segmentBytes: 16777216, disks: [] } },
        }),
      },
      update: {
        proxmox_clusters: chain({ executeTakeFirst: { id: 'cluster-1' } }),
        proxmox_run_items: itemUpdate,
      },
    });

    const tasks = await service.claimTasks('agent-1', agentPve1.proxmox_info);

    expect(tasks.map((t) => t.type)).toEqual(['proxmox-inventory', 'proxmox-backup']);
    const backup = tasks[1];
    expect(backup).toEqual(
      expect.objectContaining({
        taskId: ITEM,
        repository: 's3:bucket/repo',
        options: { compression: 'max' },
        proxmox: expect.objectContaining({
          clusterSlug: 'prod',
          guest: { vmid: 100, type: 'qemu', name: 'web', node: 'pve1' },
          parentSnapshotId: 'snap-0',
          cbt: expect.objectContaining({ bitmap: 'amber-1' }),
          vmMethod: 'auto',
        }),
      }),
    );
    // parallelPerNode 1: only the first of the two queued items starts.
    expect(itemUpdate.set).toHaveBeenCalledTimes(1);
  });

  it('hands out one guest at a time until the job has backed up a guest', async () => {
    // A new repository: parallel guests would each run `restic init` and
    // leave config and keys under different master keys.
    const queued = [
      { id: ITEM, job_id: 'job-1', proxmox_config: { allGuests: true, vmids: [], parallelPerNode: 3 } },
      { id: 'item-2', job_id: 'job-1', proxmox_config: { allGuests: true, vmids: [], parallelPerNode: 3 } },
      { id: 'item-3', job_id: 'job-1', proxmox_config: { allGuests: true, vmids: [], parallelPerNode: 3 } },
    ];
    const claim = (proven: boolean) => {
      const itemUpdate = chain({
        executeTakeFirst: { id: ITEM, job_id: 'job-1', vmid: 100, guest_type: 'qemu', name: 'web', node: 'pve1' },
      });
      const guests = chain({
        execute: proven ? [{ job_id: 'job-1' }] : [],
        executeTakeFirst: { last_snapshot_id: proven ? 'snap-0' : null, cbt: null },
      });
      const { service } = make({
        select: {
          proxmox_clusters: chain({ executeTakeFirst: cluster }),
          proxmox_run_items: queuedThenNoneRunning(queued),
          job_runs: chain({ execute: [] }),
          proxmox_job_guests: guests,
        },
        update: { proxmox_run_items: itemUpdate },
      });
      return { service, itemUpdate };
    };

    const fresh = claim(false);
    await fresh.service.claimTasks('agent-1', agentPve1.proxmox_info);
    expect(fresh.itemUpdate.set).toHaveBeenCalledTimes(1);

    const proven = claim(true);
    await proven.service.claimTasks('agent-1', agentPve1.proxmox_info);
    expect(proven.itemUpdate.set).toHaveBeenCalledTimes(3);
  });

  it('gives an agent of an unknown cluster nothing', async () => {
    const { service } = make({ select: { proxmox_clusters: chain({ executeTakeFirst: undefined }) } });
    expect(await service.claimTasks('agent-9', agentPve1.proxmox_info)).toEqual([]);
    expect(await service.claimTasks('agent-9', undefined)).toEqual([]);
  });
});

describe('ProxmoxService — results', () => {
  const runningItem = {
    id: ITEM,
    run_id: RUN,
    job_id: 'job-1',
    vmid: 100,
    guest_type: 'qemu',
    name: 'web',
    node: 'pve1',
    agent_id: 'agent-1',
    status: 'running',
    moves: 0,
  };

  it('records a success, keeps parent + CBT for the next run and moves the run to its finishing task', async () => {
    const items = chain({
      executeTakeFirst: runningItem,
      execute: [{ vmid: 100, name: 'web', status: 'success', result: { dataAdded: 5 }, error: null }],
    });
    const itemUpdate = chain({ executeTakeFirst: { id: ITEM } });
    const guests = chain();
    const runUpdate = chain({ executeTakeFirst: { id: RUN } });
    const { service, retries } = make({
      select: { proxmox_run_items: items },
      update: { proxmox_run_items: itemUpdate, job_runs: runUpdate },
      insert: { proxmox_job_guests: guests },
    });

    const handled = await service.recordItemResult('agent-1', ITEM, {
      status: 'success',
      proxmoxGuest: {
        vmid: 100,
        type: 'qemu',
        name: 'web',
        node: 'pve1',
        status: 'success',
        method: 'block',
        cbt: 'incremental',
        snapshotId: 'snap-1',
        dataAdded: 5,
        nextCbt: { bitmap: 'amber-2', node: 'pve1', segmentBytes: 16777216, disks: [] },
      },
    });

    expect(handled).toBe(true);
    expect(itemUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', method: 'block' }));
    expect(guests.values).toHaveBeenCalledWith(
      expect.objectContaining({
        vmid: 100,
        last_snapshot_id: 'snap-1',
        last_status: 'success',
        cbt: expect.stringContaining('amber-2'),
      }),
    );
    expect(runUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ proxmox_phase: 'retention' }));
    expect(retries.finalize).not.toHaveBeenCalled();
  });

  it('does not treat a non-item task id as an item', async () => {
    const { service } = make({ select: { proxmox_run_items: chain({ executeTakeFirst: undefined }) } });
    expect(await service.recordItemResult('agent-1', 'stats-repo', { status: 'success' })).toBe(false);
    expect(await service.recordItemResult('agent-1', RUN, { status: 'success' })).toBe(false);
  });

  it('rejects a result from another agent', async () => {
    const { service } = make({ select: { proxmox_run_items: chain({ executeTakeFirst: runningItem }) } });
    await expect(service.recordItemResult('agent-2', ITEM, { status: 'success' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('re-queues a guest that moved to another node with an agent', async () => {
    const itemUpdate = chain();
    const { service } = make({
      select: {
        proxmox_run_items: chain({ executeTakeFirst: runningItem }),
        agents: chain({ execute: [agentPve1, agentPve2] }),
      },
      update: { proxmox_run_items: itemUpdate },
    });
    // The join lookup for the cluster id goes through proxmox_run_items too.
    (service as unknown as { db: { selectFrom: jest.Mock } }).db.selectFrom.mockImplementation((t: string) =>
      t.startsWith('agents')
        ? chain({ execute: [agentPve1, agentPve2] })
        : chain({ executeTakeFirst: { ...runningItem, pve_cluster_id: PVE_ID } }),
    );

    await service.recordItemResult('agent-1', ITEM, {
      status: 'failed',
      proxmoxGuest: { vmid: 100, type: 'qemu', name: 'web', node: 'pve1', status: 'moved', movedTo: 'pve2' },
    });

    expect(itemUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'queued', node: 'pve2', agent_id: null, moves: 1 }),
    );
  });

  it('gives up on a guest that keeps moving', async () => {
    const itemUpdate = chain();
    const { service } = make({
      select: {
        proxmox_run_items: chain({ executeTakeFirst: { ...runningItem, moves: 3 }, execute: [] }),
      },
      update: { proxmox_run_items: itemUpdate },
    });

    await service.recordItemResult('agent-1', ITEM, {
      status: 'failed',
      proxmoxGuest: { vmid: 100, type: 'qemu', name: 'web', node: 'pve1', status: 'moved', movedTo: 'pve2' },
    });

    expect(itemUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: expect.stringContaining('kept moving') }),
    );
  });

  it('finishes a run without a successful guest at once, without a finishing task', async () => {
    const runUpdate = chain({ executeTakeFirst: { id: RUN } });
    const { service, retries } = make({
      select: {
        proxmox_run_items: chain({
          execute: [{ vmid: 100, name: 'web', status: 'failed', result: null, error: 'boom' }],
        }),
      },
      update: { job_runs: runUpdate },
    });

    await service.settleIfDone(RUN);

    expect(runUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: expect.stringContaining('100 (web): boom') }),
    );
    expect(retries.finalize).toHaveBeenCalledWith(RUN);
  });

  it('waits while guests are still open', async () => {
    const runUpdate = chain({ executeTakeFirst: { id: RUN } });
    const { service } = make({
      select: {
        proxmox_run_items: chain({ execute: [{ vmid: 100, name: 'web', status: 'running', result: null, error: null }] }),
      },
      update: { job_runs: runUpdate },
    });

    await service.settleIfDone(RUN);
    expect(runUpdate.set).not.toHaveBeenCalled();
  });

  it('records the finishing task (forget, prune, repo figures) and settles the run', async () => {
    const runUpdate = chain({ executeTakeFirst: { id: RUN } });
    const { service, retries, pruneRunner, repositories } = make({
      select: {
        job_runs: chain({
          executeTakeFirst: {
            id: RUN,
            job_id: 'job-1',
            trigger: 'schedule',
            agent_id: 'agent-1',
            proxmox_phase: 'retention_running',
            repository_id: 'repo-1',
          },
        }),
        proxmox_run_items: chain({
          execute: [{ vmid: 100, name: 'web', status: 'success', result: { snapshotId: 's' }, error: null }],
        }),
      },
      update: { job_runs: runUpdate },
    });

    await service.recordRetention('agent-1', RUN, {
      status: 'success',
      forgetResult: [{ remove: [] }],
      repoStats: { sizeBytes: 10, snapshotCount: 2 },
      prune: { status: 'success', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
    });

    expect(repositories.recordStats).toHaveBeenCalledWith('repo-1', { size_bytes: 10, snapshot_count: 2 });
    expect(pruneRunner.record).toHaveBeenCalledWith(expect.objectContaining({ parentRunId: RUN, agentId: 'agent-1' }));
    expect(runUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', proxmox_phase: 'done' }));
    expect(retries.finalize).toHaveBeenCalledWith(RUN);
  });

  it('refuses a finishing task result from an agent that did not claim it', async () => {
    const { service } = make({
      select: { job_runs: chain({ executeTakeFirst: { id: RUN, agent_id: 'agent-1' } }) },
    });
    await expect(service.recordRetention('agent-2', RUN, { status: 'success' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ProxmoxService — task state', () => {
  it('reports an item cancelled when its run was cancelled', async () => {
    const { service } = make({
      select: {
        proxmox_run_items: chain({ executeTakeFirst: { status: 'running', agent_id: 'agent-1', run_status: 'cancelled' } }),
      },
    });
    expect(await service.taskState('agent-1', ITEM)).toEqual({ cancelled: true });
  });

  it('stops an obsolete copy of an item that moved to another agent', async () => {
    const { service } = make({
      select: {
        proxmox_run_items: chain({ executeTakeFirst: { status: 'running', agent_id: 'agent-2', run_status: 'running' } }),
      },
    });
    expect(await service.taskState('agent-1', ITEM)).toEqual({ cancelled: true });
  });

  it('leaves unknown ids to the job/restore lookup', async () => {
    const { service } = make({ select: { proxmox_run_items: chain({ executeTakeFirst: undefined }) } });
    expect(await service.taskState('agent-1', ITEM)).toBeNull();
    expect(await service.taskState('agent-1', 'stats-x')).toBeNull();
  });

  it('answers for the finishing task of a run', async () => {
    const { service } = make({
      select: { job_runs: chain({ executeTakeFirst: { status: 'running', agent_id: 'agent-1' } }) },
    });
    expect(await service.taskState('agent-1', `pveret-${RUN}`)).toEqual({ cancelled: false });
  });
});

describe('ProxmoxService — clusters', () => {
  it('refuses to register the same PVE cluster twice', async () => {
    const { service } = make({
      select: {
        agents: chain({ executeTakeFirst: { id: 'agent-1', proxmox_info: agentPve1.proxmox_info } }),
        proxmox_clusters: chain({ executeTakeFirst: { name: 'Prod' } }),
      },
    });
    await expect(
      service.create({ id: 'u-1' } as never, { name: 'Again', primaryAgentId: 'agent-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a primary agent that announces no PVE node', async () => {
    const { service } = make({
      select: { agents: chain({ executeTakeFirst: { id: 'agent-1', proxmox_info: null } }) },
    });
    await expect(
      service.create({ id: 'u-1' } as never, { name: 'Prod', primaryAgentId: 'agent-1' }),
    ).rejects.toThrow(/does not run on a Proxmox VE node/);
  });

  it('refuses to delete a cluster that jobs still back up', async () => {
    const { service } = make({
      select: {
        proxmox_clusters: chain({ executeTakeFirst: cluster }),
        backup_jobs: chain({ executeTakeFirst: { name: 'Nightly' } }),
      },
    });
    await expect(service.remove('cluster-1')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('Proxmox DTOs', () => {
  it('validates a job config', async () => {
    const ok = plainToInstance(ProxmoxJobConfigDto, {
      allGuests: false,
      vmids: [100, 101],
      pools: ['web'],
      types: ['lxc'],
      parallelPerNode: 2,
    });
    expect(await validate(ok)).toEqual([]);
    const bad = plainToInstance(ProxmoxJobConfigDto, { allGuests: false, vmids: [5], parallelPerNode: 9 });
    expect((await validate(bad)).map((e) => e.property).sort()).toEqual(['parallelPerNode', 'vmids']);
  });

  it('validates a restore spec', async () => {
    const ok = plainToInstance(ProxmoxRestoreSpecDto, {
      clusterId: '33333333-3333-4333-8333-333333333333',
      vmid: 100,
      guestType: 'qemu',
      action: 'guest',
      targetNode: 'pve2',
      storage: 'local-zfs',
      unique: true,
    });
    expect(await validate(ok)).toEqual([]);
    const bad = plainToInstance(ProxmoxRestoreSpecDto, {
      clusterId: 'x',
      vmid: 100,
      guestType: 'qemu',
      action: 'guest',
      targetNode: 'pve2; rm -rf /',
    });
    expect((await validate(bad)).map((e) => e.property).sort()).toEqual(['clusterId', 'targetNode']);
  });
});
