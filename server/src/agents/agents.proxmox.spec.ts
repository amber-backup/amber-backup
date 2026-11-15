import { chain, createDbMock, TEST_MASTER_KEY } from '../testing/db-mock';

process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;
process.env.PUBLIC_BASE_URL = 'https://backup.example.com';

import { ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CryptoService } from '../crypto/crypto.service';
import { AgentsService } from './agents.service';
import { TargetsService } from '../targets/targets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { PruneRunnerService } from '../jobs/prune-runner.service';
import { CheckRunnerService } from '../jobs/check-runner.service';
import { RunRetryService } from '../jobs/run-retry.service';
import { HypervService } from '../hyperv/hyperv.service';
import { ProxmoxService } from '../proxmox/proxmox.service';
import { PollDto, TaskResultDto } from './dto/agent.dto';

const ITEM = '22222222-2222-4222-8222-222222222222';
const RUN = '11111111-1111-4111-8111-111111111111';
const info = { clusterId: 'ab'.repeat(32), clusterName: 'prod', node: 'pve1', pveVersion: 'pve-manager/8.2.4' };

describe('AgentsService (Proxmox dispatch)', () => {
  function make(opts: { restoreRuns?: unknown[] } = {}) {
    const jobRuns = chain({ execute: [] });
    const restoreRuns = chain({ execute: opts.restoreRuns ?? [] });
    const agentsUpdate = chain({ executeTakeFirst: { poll_interval_seconds: 30, id: 'x' } });
    const mock = createDbMock({
      selectFrom: (t) => (t === 'restore_runs' ? restoreRuns : jobRuns),
      updateTable: agentsUpdate,
    });
    const targets = {
      resolveForRestore: jest.fn().mockResolvedValue({
        repository: 's3:bucket/repo',
        password: 'pw',
        env: {},
        credentialFiles: [],
      }),
    } as unknown as TargetsService;
    const repos = { claimStatsRequests: jest.fn().mockResolvedValue([]) } as unknown as RepositoriesService;
    const proxmox = {
      claimTasks: jest.fn().mockResolvedValue([{ type: 'proxmox-backup', taskId: ITEM }]),
      recordInventory: jest.fn().mockResolvedValue(undefined),
      recordRetention: jest.fn().mockResolvedValue(undefined),
      recordItemResult: jest.fn().mockResolvedValue(false),
      recordItemProgress: jest.fn().mockResolvedValue(false),
      taskState: jest.fn().mockResolvedValue(null),
      releaseAgent: jest.fn().mockResolvedValue(undefined),
      restorePayload: jest.fn().mockResolvedValue({ clusterId: 'c-1', clusterSlug: 'prod', restore: {} }),
    };
    const service = new AgentsService(
      mock.db,
      new CryptoService(),
      targets,
      {} as NotificationsService,
      repos,
      {} as PruneRunnerService,
      {} as CheckRunnerService,
      { finalize: jest.fn() } as unknown as RunRetryService,
      {} as HypervService,
      proxmox as unknown as ProxmoxService,
    );
    return { service, proxmox, jobRuns, agentsUpdate, mock };
  }

  it('records what a node agent announces and hands it its Proxmox tasks', async () => {
    const { service, proxmox, agentsUpdate } = make();

    const { tasks } = await service.poll({ id: 'agent-1' } as never, {
      capabilities: ['check', 'stats', 'proxmox'],
      proxmox: info,
    });

    expect(agentsUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ proxmox_info: JSON.stringify(info) }),
    );
    expect(proxmox.claimTasks).toHaveBeenCalledWith('agent-1', info);
    expect(tasks).toContainEqual(expect.objectContaining({ type: 'proxmox-backup', taskId: ITEM }));
  });

  it('never hands Proxmox tasks to an agent without the capability', async () => {
    const { service, proxmox, agentsUpdate } = make();

    await service.poll({ id: 'agent-1' } as never, { capabilities: ['check'] });

    expect(proxmox.claimTasks).not.toHaveBeenCalled();
    expect(agentsUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ proxmox_info: null }));
  });

  it('keeps Proxmox runs out of the plain backup claim', async () => {
    const { service, jobRuns } = make();
    await service.poll({ id: 'agent-1' } as never, { capabilities: ['proxmox'], proxmox: info });
    expect(jobRuns.where).toHaveBeenCalledWith('backup_jobs.source_kind', '!=', 'proxmox');
  });

  it('routes inventory, finishing-task and item results to the Proxmox service', async () => {
    const { service, proxmox } = make();
    const inventory = { clusterName: 'prod', pveVersion: 'x', readBy: 'pve1', nodes: [], storages: [], guests: [] };

    await service.submitResult('agent-1', 'pveinv-c-1', { status: 'success', proxmoxInventory: inventory as never });
    expect(proxmox.recordInventory).toHaveBeenCalledWith('agent-1', 'c-1', {
      status: 'success',
      inventory,
      error: undefined,
    });

    await service.submitResult('agent-1', `pveret-${RUN}`, { status: 'success' });
    expect(proxmox.recordRetention).toHaveBeenCalledWith('agent-1', RUN, { status: 'success' });

    proxmox.recordItemResult.mockResolvedValueOnce(true);
    await service.submitResult('agent-1', ITEM, { status: 'success' });
    expect(proxmox.recordItemResult).toHaveBeenCalledWith('agent-1', ITEM, { status: 'success' });
  });

  it('routes item progress and task state to the Proxmox service', async () => {
    const { service, proxmox } = make();
    proxmox.recordItemProgress.mockResolvedValueOnce(true);
    await service.submitProgress('agent-1', ITEM, { percentDone: 0.5 });
    expect(proxmox.recordItemProgress).toHaveBeenCalledWith('agent-1', ITEM, { percentDone: 0.5 });

    proxmox.taskState.mockResolvedValueOnce({ cancelled: true });
    expect(await service.taskState('agent-1', ITEM)).toEqual({ cancelled: true });
  });

  it('builds a proxmox-restore task, or fails it for an agent without Proxmox', async () => {
    const restoreRun = {
      id: 'restore-1',
      mode: 'proxmox',
      agent_id: 'agent-1',
      snapshot_id: 'snap-1',
      destination: { agentId: 'agent-1', proxmox: { clusterId: 'c-1', vmid: 100, action: 'guest' } },
      options: {},
      included_paths: null,
    };
    let { service } = make({ restoreRuns: [restoreRun] });
    let res = await service.poll({ id: 'agent-1' } as never, { capabilities: ['proxmox'], proxmox: info });
    expect(res.tasks).toContainEqual(
      expect.objectContaining({ type: 'proxmox-restore', taskId: 'restore-1', snapshotId: 'snap-1' }),
    );

    const fresh = make({ restoreRuns: [restoreRun] });
    service = fresh.service;
    res = await service.poll({ id: 'agent-1' } as never, { capabilities: [] });
    expect(res.tasks.find((t) => t.taskId === 'restore-1')).toBeUndefined();
    expect(fresh.agentsUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: expect.stringContaining('Proxmox') }),
    );
  });

  it('releases the clusters of an agent before deleting it', async () => {
    const { service, mock, proxmox } = make();
    await service.remove('agent-1');
    expect(proxmox.releaseAgent).toHaveBeenCalledWith('agent-1');
    expect(mock.deleteFrom).toHaveBeenCalledWith('agents');
  });

  it('keeps an agent whose cluster cannot be released', async () => {
    const { service, mock, proxmox } = make();
    proxmox.releaseAgent.mockRejectedValue(new ConflictException('last agent'));
    await expect(service.remove('agent-1')).rejects.toBeInstanceOf(ConflictException);
    expect(mock.deleteFrom).not.toHaveBeenCalled();
  });
});

describe('Agent DTOs (Proxmox)', () => {
  it('accepts a poll announcement and rejects a bad node name', async () => {
    expect(await validate(plainToInstance(PollDto, { proxmox: info }), { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    const errors = await validate(
      plainToInstance(PollDto, { proxmox: { ...info, node: 'pve1; reboot' } }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors).toHaveLength(1);
  });

  it('accepts a guest result with an opaque CBT state', async () => {
    const dto = plainToInstance(TaskResultDto, {
      status: 'success',
      snapshotId: 'abc',
      proxmoxGuest: {
        vmid: 100,
        type: 'qemu',
        name: 'web',
        node: 'pve1',
        status: 'success',
        method: 'block',
        cbt: 'full',
        cbtReason: 'no previous bitmap',
        nextCbt: { bitmap: 'amber-x', node: 'pve1', segmentBytes: 16777216, disks: [{ key: 'scsi0', sizeBytes: 1 }], extra: 1 },
        warnings: ['crash-consistent'],
      },
    });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
  });

  it('accepts a full inventory', async () => {
    const dto = plainToInstance(TaskResultDto, {
      status: 'success',
      proxmoxInventory: {
        clusterName: null,
        pveVersion: 'pve-manager/8.2.4',
        readBy: 'pve1',
        nodes: [{ name: 'pve1', online: true }],
        storages: [{ id: 'local-zfs', type: 'zfspool', shared: false, content: ['images', 'rootdir'], nodes: [], snapshots: true }],
        guests: [
          {
            vmid: 100,
            type: 'lxc',
            name: 'dns',
            node: 'pve1',
            status: 'running',
            template: false,
            tags: ['prod'],
            unprivileged: true,
            disks: [{ key: 'rootfs', volid: 'local-zfs:subvol-100-disk-0', storage: 'local-zfs', sizeBytes: 8e9, backup: true }],
            autoMethod: 'files',
            staleSnapshots: [],
          },
        ],
      },
    });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
  });
});
