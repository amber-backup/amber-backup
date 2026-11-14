import { chain, createDbMock, TEST_MASTER_KEY } from '../testing/db-mock';

process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;
process.env.PUBLIC_BASE_URL = 'https://backup.example.com';

import { CryptoService } from '../crypto/crypto.service';
import { AgentsService } from './agents.service';
import { TargetsService } from '../targets/targets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { PruneRunnerService } from '../jobs/prune-runner.service';
import { CheckRunnerService } from '../jobs/check-runner.service';
import { RunRetryService } from '../jobs/run-retry.service';
import { HypervService } from '../hyperv/hyperv.service';

describe('AgentsService (Hyper-V dispatch)', () => {
  const agent = { id: 'agent-1' } as never;
  const hostRow = { id: 'host-1', mode: 'local', agent_id: 'agent-1' };
  const hypervRun = {
    run_id: 'run-1',
    job_id: 'job-1',
    job_name: 'VMs',
    target_id: 't-1',
    repo_config: {},
    repo_password_secret_id: 's-1',
    credential_secret_id: null,
    restic_options: {},
    paths: [],
    source_kind: 'hyperv',
    hyperv_host_id: 'host-1',
    hyperv_config: { allVms: false, vmIds: ['aaaaaaaa-0000-0000-0000-000000000001'] },
  };

  function make(runs: unknown[] = [hypervRun]) {
    const jobRuns = chain({ execute: runs });
    const restoreRuns = chain({ execute: [] });
    const updates = chain({ executeTakeFirst: { poll_interval_seconds: 30, id: 'run-1' } });
    const { db } = createDbMock({
      selectFrom: (t) => (t === 'restore_runs' ? restoreRuns : jobRuns),
      updateTable: updates,
    });
    const targets = {
      resolveForJob: jest.fn().mockResolvedValue({
        repository: 's3:bucket/repo',
        password: 'pw',
        env: {},
        credentialFiles: [],
      }),
    } as unknown as TargetsService;
    const repos = { claimStatsRequests: jest.fn().mockResolvedValue([]) } as unknown as RepositoriesService;
    const retries = { finalize: jest.fn(async () => undefined) } as unknown as RunRetryService;
    const hyperv = {
      getRow: jest.fn().mockResolvedValue(hostRow),
      connection: jest.fn().mockResolvedValue({ mode: 'local' }),
      claimInventoryTasks: jest.fn().mockResolvedValue([{ type: 'hyperv-inventory', taskId: 'hvinv-host-1' }]),
      recordInventory: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AgentsService(
      db,
      new CryptoService(),
      targets,
      {} as NotificationsService,
      repos,
      {} as PruneRunnerService,
      {} as CheckRunnerService,
      retries,
      hyperv as unknown as HypervService,
    );
    return { service, hyperv, updates, retries };
  }

  it('hands a Hyper-V backup to an agent that announces Hyper-V', async () => {
    const { service, hyperv } = make();

    const { tasks } = await service.poll(agent, { capabilities: ['check', 'stats', 'hyperv'] });

    expect(tasks).toContainEqual(
      expect.objectContaining({
        type: 'hyperv-backup',
        taskId: 'run-1',
        repository: 's3:bucket/repo',
        hyperv: {
          connection: { mode: 'local' },
          allVms: false,
          vmIds: ['aaaaaaaa-0000-0000-0000-000000000001'],
          excludeVmIds: [],
          checkpointMode: 'Production',
          parallelVms: 1,
        },
      }),
    );
    expect(tasks).toContainEqual(expect.objectContaining({ type: 'hyperv-inventory' }));
    expect(hyperv.getRow).toHaveBeenCalledWith('host-1');
  });

  it('fails a Hyper-V run instead of handing it to an agent without Hyper-V', async () => {
    const { service, hyperv, updates, retries } = make();

    const { tasks } = await service.poll(agent, { capabilities: ['check', 'stats'] });

    expect(tasks.filter((t) => t.type === 'backup' || t.type === 'hyperv-backup')).toEqual([]);
    expect(updates.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: expect.stringContaining('Hyper-V') }),
    );
    expect(retries.finalize).toHaveBeenCalledWith('run-1');
    expect(hyperv.claimInventoryTasks).not.toHaveBeenCalled();
  });

  it('keeps handing plain file backups out as before', async () => {
    const { service } = make([{ ...hypervRun, source_kind: 'files', hyperv_host_id: null, hyperv_config: null, paths: ['/data'] }]);

    const { tasks } = await service.poll(agent, { capabilities: ['hyperv'] });

    expect(tasks).toContainEqual(expect.objectContaining({ type: 'backup', paths: ['/data'] }));
    expect(tasks.find((t) => t.taskId === 'run-1')?.hyperv).toBeUndefined();
  });

  it('routes an inventory result to the Hyper-V service', async () => {
    const { service, hyperv } = make([]);
    const inventory = { computerName: 'HV01', os: 'Windows Server 2022', vms: [] };

    await service.submitResult('agent-1', 'hvinv-host-1', { status: 'success', hypervInventory: inventory });

    expect(hyperv.recordInventory).toHaveBeenCalledWith('agent-1', 'host-1', {
      status: 'success',
      inventory,
      error: undefined,
    });
  });
});
