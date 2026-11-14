import { BadRequestException, NotFoundException } from '@nestjs/common';
import { chain, createDbMock } from '../testing/db-mock';
import { RestoreService } from './restore.service';
import { AccessControlService } from '../common/access-control.service';
import { RequestUser } from '../common/auth/request-user';
import { JobsService } from '../jobs/jobs.service';
import { RestoreRunnerService } from './restore-runner.service';

const admin = { id: 'u1', isAdmin: true } as RequestUser;

interface Row {
  id: string;
  job_id: string | null;
  status: string;
  agent_id?: string | null;
}

function setup(run: Row, opts: { local?: boolean } = {}) {
  const update = chain({ execute: [] });
  const { db } = createDbMock({
    selectFrom: chain({ executeTakeFirst: run }),
    updateTable: update,
  });
  const acl = { assert: jest.fn(async () => undefined) } as unknown as AccessControlService;
  const runner = {
    cancel: jest.fn(() => opts.local ?? false),
  } as unknown as RestoreRunnerService;
  const service = new RestoreService(db, acl, {} as JobsService, runner);
  return { service, update, runner, acl };
}

describe('RestoreService.cancel', () => {
  it('aborts a local restore through the runner without touching the row', async () => {
    const { service, update, runner } = setup(
      { id: 'rs1', job_id: 'j1', status: 'running' },
      { local: true },
    );

    await expect(service.cancel(admin, 'rs1')).resolves.toEqual({ cancelled: true });

    expect(runner.cancel).toHaveBeenCalledWith('rs1');
    // The runner writes the final status itself.
    expect(update.set).not.toHaveBeenCalled();
  });

  it('marks a queued restore cancelled', async () => {
    const { service, update } = setup({ id: 'rs2', job_id: 'j1', status: 'queued' });

    await service.cancel(admin, 'rs2');

    const patch = update.set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe('cancelled');
    expect(patch.error).toBeNull();
    expect(patch.finished_at).toBeInstanceOf(Date);
    expect(update.where).toHaveBeenCalledWith('status', 'in', ['queued', 'running']);
  });

  it('cancels a restore running on an agent, which may still be at work', async () => {
    const { service, update } = setup({
      id: 'rs3',
      job_id: 'j1',
      status: 'running',
      agent_id: 'a1',
    });

    await service.cancel(admin, 'rs3');

    const patch = update.set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe('cancelled');
    expect(patch.error).toBe(
      'Cancelled on the server — the agent may still be running this task.',
    );
  });

  it('force-cancels a hung local restore whose process is gone', async () => {
    const { service, update } = setup({ id: 'rs4', job_id: 'j1', status: 'running' });

    await service.cancel(admin, 'rs4');

    const patch = update.set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.error).toMatch(/no running process/i);
  });

  it('rejects cancelling a finished restore', async () => {
    const { service, update } = setup({ id: 'rs5', job_id: 'j1', status: 'success' });

    await expect(service.cancel(admin, 'rs5')).rejects.toBeInstanceOf(BadRequestException);
    expect(update.set).not.toHaveBeenCalled();
  });

  it('hides a restore of a deleted job from non-admins', async () => {
    const { service } = setup({ id: 'rs6', job_id: null, status: 'running' });

    await expect(
      service.cancel({ id: 'u2', isAdmin: false } as RequestUser, 'rs6'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('RestoreService.create (proxmox)', () => {
  const spec = {
    clusterId: 'c-1',
    vmid: 100,
    guestType: 'qemu' as const,
    action: 'guest' as const,
    targetNode: 'pve2',
  };

  function setupCreate(opts: { sourceKind?: string; agent?: unknown } = {}) {
    const insert = chain({ executeTakeFirstOrThrow: { id: 'rs-new' } });
    const { db } = createDbMock({
      selectFrom: (t) =>
        t === 'proxmox_clusters'
          ? chain({ executeTakeFirst: { id: 'c-1', pve_cluster_id: 'ab'.repeat(32) } })
          : chain({ executeTakeFirst: 'agent' in opts ? opts.agent : { id: 'agent-2' } }),
      insertInto: insert,
    });
    const acl = { assert: jest.fn(async () => undefined) } as unknown as AccessControlService;
    const jobs = {
      getRow: jest.fn(async () => ({
        id: 'j1',
        source_kind: opts.sourceKind ?? 'proxmox',
        target_id: 't1',
        repo_config: {},
        repo_password_secret_id: 's1',
        credential_secret_id: null,
      })),
    } as unknown as JobsService;
    const runner = { dispatch: jest.fn(async () => undefined) } as unknown as RestoreRunnerService;
    return { service: new RestoreService(db, acl, jobs, runner), insert };
  }

  it("runs a guest restore on the target node's agent", async () => {
    const { service, insert } = setupCreate();
    await service.create(admin, {
      jobId: 'j1',
      snapshotId: 'snap-1',
      mode: 'proxmox',
      includedPaths: ['/etc'],
      destination: { proxmox: spec },
    });
    expect(insert.values).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'proxmox', agent_id: 'agent-2', included_paths: null }),
    );
  });

  it('refuses a node without an agent, a non-Proxmox job and file restores of VMs', async () => {
    await expect(
      setupCreate({ agent: undefined }).service.create(admin, {
        jobId: 'j1',
        snapshotId: 's',
        mode: 'proxmox',
        destination: { proxmox: spec },
      }),
    ).rejects.toThrow(/No Amber agent runs on node pve2/);
    await expect(
      setupCreate({ sourceKind: 'files' }).service.create(admin, {
        jobId: 'j1',
        snapshotId: 's',
        mode: 'proxmox',
        destination: { proxmox: spec },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      setupCreate().service.create(admin, {
        jobId: 'j1',
        snapshotId: 's',
        mode: 'proxmox',
        destination: { proxmox: { ...spec, action: 'files' } },
      }),
    ).rejects.toThrow(/Only container backups/);
  });
});

describe('RestoreService.create (proxmox vm-files and live restore)', () => {
  const vmSpec = {
    clusterId: 'c-1',
    vmid: 100,
    guestType: 'qemu' as const,
    action: 'guest' as const,
    targetNode: 'pve2',
  };
  const inventory = {
    clusterName: 'lab',
    pveVersion: 'pve-manager/8.2.4',
    readBy: 'pve1',
    nodes: [],
    guests: [],
    storages: [
      { id: 'local', type: 'dir', shared: false, content: ['images', 'iso'], nodes: [], snapshots: false },
      { id: 'local-zfs', type: 'zfspool', shared: false, content: ['images'], nodes: [], snapshots: true },
      { id: 'isos', type: 'nfs', shared: true, content: ['iso'], nodes: [], snapshots: false },
      { id: 'pve1-only', type: 'dir', shared: false, content: ['images'], nodes: ['pve1'], snapshots: false },
    ],
  };

  function setup() {
    const insert = chain({ executeTakeFirstOrThrow: { id: 'rs-new' } });
    const { db } = createDbMock({
      selectFrom: (t) =>
        t === 'proxmox_clusters'
          ? chain({ executeTakeFirst: { id: 'c-1', pve_cluster_id: 'ab'.repeat(32), inventory } })
          : chain({ executeTakeFirst: { id: 'agent-2' } }),
      insertInto: insert,
    });
    const acl = { assert: jest.fn(async () => undefined) } as unknown as AccessControlService;
    const jobs = {
      getRow: jest.fn(async () => ({
        id: 'j1',
        source_kind: 'proxmox',
        target_id: 't1',
        repo_config: {},
        repo_password_secret_id: 's1',
        credential_secret_id: null,
      })),
    } as unknown as JobsService;
    const runner = { dispatch: jest.fn(async () => undefined) } as unknown as RestoreRunnerService;
    return { service: new RestoreService(db, acl, jobs, runner), insert };
  }
  const create = (service: RestoreService, proxmox: Record<string, unknown>, includedPaths?: string[]) =>
    service.create(admin, {
      jobId: 'j1',
      snapshotId: 'snap-1',
      mode: 'proxmox',
      includedPaths,
      destination: { proxmox: { ...vmSpec, ...proxmox } as never },
    });

  it('keeps the guest paths of a vm-files restore and runs it on the node', async () => {
    const { service, insert } = setup();
    await create(service, { action: 'vm-files', targetPath: '/root/restore' }, ['/etc/nginx', 'p2:/data', 'scsi0p1:/home']);
    expect(insert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: 'agent-2',
        included_paths: JSON.stringify(['/etc/nginx', 'p2:/data', 'scsi0p1:/home']),
      }),
    );
  });

  it('refuses vm-files for containers, without a usable target or with bad paths', async () => {
    const { service } = setup();
    await expect(create(service, { action: 'vm-files', guestType: 'lxc', targetPath: '/x' })).rejects.toThrow(
      /Only VM backups/,
    );
    await expect(create(service, { action: 'vm-files' })).rejects.toThrow(/targetPath/);
    await expect(create(service, { action: 'vm-files', targetPath: '/' })).rejects.toThrow(/other than \//);
    await expect(create(service, { action: 'vm-files', targetPath: '/a/../b' })).rejects.toThrow(/targetPath/);
    await expect(create(service, { action: 'vm-files', targetPath: '/x' }, ['etc'])).rejects.toThrow(/no guest path/);
    await expect(create(service, { action: 'vm-files', targetPath: '/x' }, ['/etc/../root'])).rejects.toThrow(
      /no guest path/,
    );
    await expect(create(service, { targetPath: '/x' })).rejects.toThrow(/only applies to vm-files/);
  });

  it('accepts a live restore onto a dir storage and checks the overlay storage', async () => {
    const { service, insert } = setup();
    await create(service, { liveRestore: true, overlayStorage: 'local', storage: 'local-zfs' });
    expect(insert.values).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'agent-2' }));

    await expect(create(service, { liveRestore: true })).rejects.toThrow(/needs overlayStorage/);
    await expect(create(service, { liveRestore: true, overlayStorage: 'local-zfs' })).rejects.toThrow(
      /cannot hold qcow2/,
    );
    await expect(create(service, { liveRestore: true, overlayStorage: 'isos' })).rejects.toThrow(/cannot hold qcow2/);
    await expect(create(service, { liveRestore: true, overlayStorage: 'nope' })).rejects.toThrow(/Unknown storage/);
    await expect(create(service, { liveRestore: true, overlayStorage: 'pve1-only' })).rejects.toThrow(
      /not available on node pve2/,
    );
    await expect(create(service, { liveRestore: true, overlayStorage: 'local', replaceOriginal: true })).rejects.toThrow(
      /cannot replace the original/,
    );
    await expect(
      create(service, { liveRestore: true, overlayStorage: 'local', guestType: 'lxc' }),
    ).rejects.toThrow(/Only whole VMs/);
    await expect(create(service, { overlayStorage: 'local' })).rejects.toThrow(/only applies to a live restore/);
  });
});
