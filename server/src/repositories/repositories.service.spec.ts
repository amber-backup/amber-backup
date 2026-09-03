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
