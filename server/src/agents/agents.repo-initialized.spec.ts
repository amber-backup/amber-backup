import { chain, createDbMock, TEST_MASTER_KEY } from '../testing/db-mock';

process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;

import { CryptoService } from '../crypto/crypto.service';
import { AgentsService } from './agents.service';
import { TargetsService } from '../targets/targets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { PruneRunnerService } from '../jobs/prune-runner.service';
import { CheckRunnerService } from '../jobs/check-runner.service';
import { RunRetryService } from '../jobs/run-retry.service';

/** `repoInitialized` on backup tasks (contract: never re-init a known repository). */
describe('AgentsService backup task repoInitialized', () => {
  function make(known: boolean) {
    const run = {
      run_id: 'run-1',
      job_id: 'job-1',
      job_name: 'Daily',
      repository_id: 'repo-1',
      target_id: null,
      repo_config: {},
      repo_password_secret_id: 'sec',
      credential_secret_id: null,
      restic_options: {},
      paths: ['/data'],
      source_kind: 'files',
      hyperv_host_id: null,
      hyperv_config: null,
    };
    const repoLookup = chain({ executeTakeFirst: known ? { id: 'repo-1' } : undefined });
    const { db } = createDbMock({
      selectFrom: (t) =>
        t === 'job_runs'
          ? chain({ execute: [run] })
          : t.startsWith('repositories')
            ? repoLookup
            : chain({ execute: [] }),
      updateTable: (t) =>
        t === 'agents'
          ? chain({ executeTakeFirst: { poll_interval_seconds: 30 } })
          : chain({ executeTakeFirst: { id: 'run-1' } }),
    });
    const targets = {
      resolveForJob: jest.fn().mockResolvedValue({
        repository: '/mnt/backup/repo',
        password: 'pw',
        env: {},
        credentialFiles: [],
      }),
    };
    const repos = { claimStatsRequests: jest.fn().mockResolvedValue([]) };
    const service = new AgentsService(
      db,
      new CryptoService(),
      targets as unknown as TargetsService,
      {} as NotificationsService,
      repos as unknown as RepositoriesService,
      {} as PruneRunnerService,
      {} as CheckRunnerService,
      { finalize: jest.fn() } as unknown as RunRetryService,
    );
    return { service, repoLookup };
  }

  it.each([true, false])('sends repoInitialized=%s from what the server knows', async (known) => {
    const { service, repoLookup } = make(known);

    const { tasks } = await service.poll({ id: 'agent-1', name: 'a' }, {} as never);

    expect(tasks).toEqual([
      expect.objectContaining({ type: 'backup', taskId: 'run-1', repoInitialized: known }),
    ]);
    expect(repoLookup.where).toHaveBeenCalledWith('r.id', '=', 'repo-1');
  });
});
