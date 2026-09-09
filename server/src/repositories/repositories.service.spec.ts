import { RepositoriesService } from './repositories.service';
import { AccessControlService } from '../common/access-control.service';
import { TargetsService } from '../targets/targets.service';
import { ResticService } from '../restic/restic.service';
import { RequestUser } from '../common/auth/request-user';
import { chain, createDbMock } from '../testing/db-mock';

describe('RepositoriesService', () => {
  const user = { id: 'u1' } as RequestUser;

  const row = {
    id: 'repo-1',
    name: 'Daily',
    slug: 'daily',
    target_id: 't1',
    repo_config: { path: 'repo' },
    repo_password_secret_id: 'sec-password',
    credential_secret_id: null as string | null,
    created_at: new Date(),
    updated_at: new Date(),
    job_id: 'job-1',
    job_name: 'Daily',
    location: 'local',
    target_name: 'REST',
    backend_type: 'rest',
  };

  function make(credentialSecretId: string | null) {
    const { db } = createDbMock({
      selectFrom: () =>
        chain({ execute: [{ ...row, credential_secret_id: credentialSecretId }] }),
    });
    const acl = { visibleResourceIds: jest.fn().mockResolvedValue('all') };
    return new RepositoriesService(
      db,
      acl as unknown as AccessControlService,
      {} as TargetsService,
      {} as ResticService,
    );
  }

  it('reports whether the repository overrides the connection credentials', async () => {
    expect(await make('sec-1').list(user)).toEqual([
      expect.objectContaining({ has_credential_override: true }),
    ]);
    expect(await make(null).list(user)).toEqual([
      expect.objectContaining({ has_credential_override: false }),
    ]);
  });

  it('never exposes secret ids', async () => {
    const [repo] = await make('sec-1').list(user);

    expect(repo).not.toHaveProperty('credential_secret_id');
    expect(repo).not.toHaveProperty('repo_password_secret_id');
  });
});

describe('RepositoriesService.refreshStats', () => {
  const row = {
    id: 'repo-1',
    target_id: 't1',
    repo_config: { path: 'repo' },
    repo_password_secret_id: 'sec-password',
    credential_secret_id: null,
    size_bytes: '100',
    snapshot_count: 1,
    stats_at: new Date('2026-01-01T00:00:00Z'),
    stats_error: 'old error',
  };

  function make(restic: Partial<ResticService>, current = row) {
    const update = chain({ execute: [] });
    const insert = chain({ execute: [] });
    const { db } = createDbMock({
      selectFrom: () => chain({ executeTakeFirst: current }),
      updateTable: update,
      insertInto: insert,
    });
    const targets = { resolveForJob: jest.fn().mockResolvedValue({}) };
    const service = new RepositoriesService(
      db,
      {} as AccessControlService,
      targets as unknown as TargetsService,
      restic as ResticService,
    );
    return { service, update, insert };
  }

  it('stores the deduplicated size and snapshot count read from restic', async () => {
    const { service, update, insert } = make({
      stats: jest.fn().mockResolvedValue({ total_size: 4096 }),
      snapshots: jest.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }]),
    });

    const result = await service.refreshStats('repo-1');

    expect(result).toEqual({
      size_bytes: 4096,
      snapshot_count: 2,
      stats_at: expect.any(Date),
      stats_error: null,
    });
    expect(update.set).toHaveBeenCalledWith({
      size_bytes: 4096,
      snapshot_count: 2,
      stats_at: expect.any(Date),
      stats_error: null,
    });
    // Changed figures are appended to the history for the growth chart.
    expect(insert.values).toHaveBeenCalledWith(
      expect.objectContaining({ repository_id: 'repo-1', size_bytes: 4096, snapshot_count: 2 }),
    );
  });

  it('does not append a history reading when nothing changed', async () => {
    const { service, insert } = make({
      stats: jest.fn().mockResolvedValue({ total_size: 100 }),
      snapshots: jest.fn().mockResolvedValue([{ id: 'a' }]),
    });

    await service.refreshStats('repo-1');

    expect(insert.values).not.toHaveBeenCalled();
  });

  it('keeps the last known figures and records the error when restic fails', async () => {
    const { service, update } = make({
      stats: jest.fn().mockRejectedValue(new Error('repository not reachable')),
      snapshots: jest.fn().mockResolvedValue([]),
    });

    const result = await service.refreshStats('repo-1');

    expect(result).toEqual({
      size_bytes: 100,
      snapshot_count: 1,
      stats_at: row.stats_at,
      stats_error: 'repository not reachable',
    });
    expect(update.set).toHaveBeenCalledWith({
      stats_error: 'repository not reachable',
    });
  });
});
