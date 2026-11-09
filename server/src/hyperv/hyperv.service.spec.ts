import { ConflictException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { chain, createDbMock } from '../testing/db-mock';
import { coversVm, HypervService } from './hyperv.service';
import { SecretsService } from '../crypto/secrets.service';
import { AccessControlService } from '../common/access-control.service';
import { ResticService } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';
import { JobsService } from '../jobs/jobs.service';
import { CreateHypervHostDto, HypervRestoreSpecDto } from './dto/hyperv.dto';

const VM = 'aaaaaaaa-0000-0000-0000-000000000001';

describe('coversVm', () => {
  it('matches selected VMs case-insensitively', () => {
    expect(coversVm({ allVms: false, vmIds: [VM.toUpperCase()] }, VM)).toBe(true);
    expect(coversVm({ allVms: false, vmIds: [] }, VM)).toBe(false);
  });

  it('covers every VM but the excluded ones with allVms', () => {
    expect(coversVm({ allVms: true, vmIds: [] }, VM)).toBe(true);
    expect(coversVm({ allVms: true, vmIds: [], excludeVmIds: [VM] }, VM)).toBe(false);
    expect(coversVm(null, VM)).toBe(false);
  });
});

describe('HypervService', () => {
  function make(builders: Parameters<typeof createDbMock>[0]) {
    const { db } = createDbMock(builders);
    const secrets = {
      create: jest.fn().mockResolvedValue('secret-1'),
      reveal: jest.fn().mockResolvedValue(JSON.stringify({ username: 'CORP\\backup', password: 'pw' })),
      update: jest.fn(),
      remove: jest.fn(),
    };
    const service = new HypervService(
      db,
      secrets as unknown as SecretsService,
      {} as AccessControlService,
      {} as ResticService,
      {} as TargetsService,
      {} as JobsService,
    );
    return { service, secrets };
  }

  it('decrypts the credential of a remote host only for the connection', async () => {
    const { service } = make({});
    const conn = await service.connection({
      mode: 'remote',
      address: 'hv01.corp.local',
      credential_secret_id: 'secret-1',
    } as never);
    expect(conn).toEqual({
      mode: 'remote',
      address: 'hv01.corp.local',
      username: 'CORP\\backup',
      password: 'pw',
    });
    expect(await service.connection({ mode: 'local' } as never)).toEqual({ mode: 'local' });
  });

  it('records an inventory only from the agent that drives the host', async () => {
    const update = chain();
    const { service } = make({
      selectFrom: chain({ executeTakeFirst: { id: 'host-1', agent_id: 'agent-1' } }),
      updateTable: update,
    });
    const inventory = { computerName: 'HV01', os: 'x', vms: [] };

    await expect(
      service.recordInventory('agent-2', 'host-1', { status: 'success', inventory }),
    ).rejects.toThrow(NotFoundException);

    await service.recordInventory('agent-1', 'host-1', { status: 'success', inventory });
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({ inventory: JSON.stringify(inventory), inventory_error: null }),
    );

    await service.recordInventory('agent-1', 'host-1', { status: 'failed', error: 'Get-VM: access denied' });
    expect(update.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ inventory_error: 'Get-VM: access denied' }),
    );
  });

  it('refuses to remove a host a job still backs up', async () => {
    const { service } = make({
      selectFrom: (t) =>
        t === 'hyperv_hosts'
          ? chain({ executeTakeFirst: { id: 'host-1', credential_secret_id: null } })
          : chain({ executeTakeFirst: { name: 'Nightly VMs' } }),
    });
    await expect(service.remove('host-1')).rejects.toThrow(ConflictException);
  });

  it('claims pending inventory refreshes as tasks with the connection', async () => {
    const { service } = make({
      updateTable: chain({ execute: [{ id: 'host-1', mode: 'local' }] }),
    });
    const tasks = await service.claimInventoryTasks('agent-1');
    expect(tasks).toEqual([
      expect.objectContaining({
        type: 'hyperv-inventory',
        taskId: 'hvinv-host-1',
        hyperv: { connection: { mode: 'local' } },
      }),
    ]);
  });
});

describe('Hyper-V DTOs', () => {
  it('rejects a remote host whose address could be read as PowerShell', async () => {
    const dto = plainToInstance(CreateHypervHostDto, {
      name: 'hv',
      mode: 'remote',
      agentId: '6f1c3b2a-1111-4222-8333-444455556666',
      address: 'hv01; Remove-Item C:\\',
      username: 'u',
      password: 'p',
    });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain('address');
  });

  it('accepts a local host without address or credentials', async () => {
    const dto = plainToInstance(CreateHypervHostDto, {
      name: 'hv',
      mode: 'local',
      agentId: '6f1c3b2a-1111-4222-8333-444455556666',
    });
    expect(await validate(dto)).toEqual([]);
  });

  it('only accepts VM names a folder can carry', async () => {
    const dto = plainToInstance(HypervRestoreSpecDto, {
      hostId: '6f1c3b2a-1111-4222-8333-444455556666',
      vmId: VM,
      action: 'vm',
      newName: '..\\..\\Windows',
    });
    expect((await validate(dto)).map((e) => e.property)).toEqual(['newName']);
  });
});

describe('HypervService.followReplacedVm', () => {
  it('points jobs that selected the replaced VM at its new id', async () => {
    const update = chain();
    const { db } = createDbMock({
      selectFrom: chain({
        execute: [
          { id: 'job-1', hyperv_config: { allVms: false, vmIds: [VM, 'bbbbbbbb-0000-0000-0000-000000000002'] } },
          { id: 'job-2', hyperv_config: { allVms: true, vmIds: [] } },
        ],
      }),
      updateTable: update,
    });
    const service = new HypervService(db, {} as never, {} as never, {} as never, {} as never, {} as never);

    await service.followReplacedVm(VM.toUpperCase(), 'CCCCCCCC-0000-0000-0000-000000000003');

    expect(update.set).toHaveBeenCalledTimes(1);
    expect(JSON.parse(update.set.mock.calls[0][0].hyperv_config)).toEqual({
      allVms: false,
      vmIds: ['cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002'],
      excludeVmIds: [],
    });
  });
});

describe('HypervService.summary', () => {
  it('reports VMs without a job and VMs whose last backup failed', async () => {
    const vm = (id: string, name: string) => ({ id, name });
    const inventory = { computerName: 'HV01', os: 'x', vms: [vm(VM, 'dc01'), vm('bbbbbbbb-0000-0000-0000-000000000002', 'web01')] };
    const { db } = createDbMock({
      selectFrom: (t) =>
        t === 'hyperv_hosts'
          ? chain({ execute: [{ id: 'host-1', name: 'hv01', inventory }] })
          : t === 'backup_jobs'
            ? chain({ execute: [{ id: 'job-1', name: 'Nightly', enabled: true, hyperv_config: { allVms: false, vmIds: [VM] } }] })
            : chain({
                execute: [
                  {
                    job_id: 'job-1',
                    finished_at: new Date(),
                    stats: { hypervVms: [{ vmId: VM, name: 'dc01', status: 'failed', error: 'checkpoint failed' }] },
                  },
                ],
              }),
    });
    const service = new HypervService(db, {} as never, {} as never, {} as never, {} as never, {} as never);

    const summary = await service.summary();

    expect(summary).toMatchObject({
      hosts: 1,
      vms: 2,
      unprotected: [{ hostId: 'host-1', vmName: 'web01' }],
      failed: [{ hostId: 'host-1', vmName: 'dc01', error: 'checkpoint failed' }],
    });
  });
});
