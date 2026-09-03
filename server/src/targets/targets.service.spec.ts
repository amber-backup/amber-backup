import { TargetsService } from './targets.service';
import { SecretsService } from '../crypto/secrets.service';
import { AccessControlService } from '../common/access-control.service';
import { SshKeyService } from './ssh-key.service';
import { chain, createDbMock } from '../testing/db-mock';

describe('TargetsService credential overrides', () => {
  const target = {
    id: 't1',
    backend_type: 'rest',
    config: { url: 'https://backup.example.com' },
    credential_secret_id: 'sec-target',
  };

  /** Secrets are keyed by id: the repo password, the connection's, the override's. */
  const secretValues: Record<string, string> = {
    'sec-password': 'repo-pw',
    'sec-target': JSON.stringify({ username: 'shared', password: 'shared-pw' }),
    'sec-override': JSON.stringify({ username: 'job-user', password: 'job-pw' }),
  };

  function make() {
    const { db } = createDbMock({
      selectFrom: () => chain({ executeTakeFirst: target }),
    });
    const secrets = {
      reveal: jest.fn((id: string) => Promise.resolve(secretValues[id])),
    };
    const service = new TargetsService(
      db,
      secrets as unknown as SecretsService,
      {} as AccessControlService,
      {} as SshKeyService,
    );
    return { service, secrets };
  }

  it('uses the connection credentials when the repository has no override', async () => {
    const { service } = make();

    const resolved = await service.resolveForJob({
      target_id: 't1',
      repo_config: { path: 'repo' },
      repo_password_secret_id: 'sec-password',
      credential_secret_id: null,
    });

    expect(resolved.repository).toBe('rest:https://shared:shared-pw@backup.example.com/repo/');
    expect(resolved.password).toBe('repo-pw');
  });

  it("lets the repository's override win over the connection credentials", async () => {
    const { service } = make();

    const resolved = await service.resolveForJob({
      target_id: 't1',
      repo_config: { path: 'repo' },
      repo_password_secret_id: 'sec-password',
      credential_secret_id: 'sec-override',
    });

    expect(resolved.repository).toBe('rest:https://job-user:job-pw@backup.example.com/repo/');
  });

  it('merges a partial override per key', async () => {
    const { service, secrets } = make();
    secrets.reveal.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'sec-override' ? JSON.stringify({ password: 'job-pw' }) : secretValues[id],
      ),
    );

    const resolved = await service.resolveForJob({
      target_id: 't1',
      repo_config: { path: 'repo' },
      repo_password_secret_id: 'sec-password',
      credential_secret_id: 'sec-override',
    });

    expect(resolved.repository).toBe('rest:https://shared:job-pw@backup.example.com/repo/');
  });

  it('applies an ad-hoc override when testing an unsaved job', async () => {
    const { service } = make();

    const resolved = await service.resolveRepoAdHoc({
      targetId: 't1',
      repoConfig: { path: 'repo' },
      repoCredentials: { username: 'probe', password: 'probe-pw' },
      repoPassword: 'repo-pw',
    });

    expect(resolved.repository).toBe('rest:https://probe:probe-pw@backup.example.com/repo/');
  });
});
