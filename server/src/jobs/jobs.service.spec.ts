import { BadRequestException } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { AccessControlService } from '../common/access-control.service';
import { SecretsService } from '../crypto/secrets.service';
import { RequestUser } from '../common/auth/request-user';
import { Db } from '../database/database.module';
import { chain, ChainBuilder } from '../testing/db-mock';

describe('JobsService credential overrides', () => {
  const user = { id: 'u1', isAdmin: true } as RequestUser;

  const baseJob = {
    id: 'job-1',
    name: 'Daily',
    location: 'local' as const,
    repository_id: 'repo-1',
    target_id: 't1',
    repo_config: { path: 'repo' },
    repo_password_secret_id: 'sec-password',
    credential_secret_id: null as string | null,
  };

  function make(job: Partial<typeof baseJob> = {}) {
    const jobRow = { ...baseJob, ...job };
    const repoInsert = chain({ executeTakeFirstOrThrow: { id: 'repo-1' } });
    const jobInsert = chain({ executeTakeFirstOrThrow: { id: 'job-1' } });
    const repoUpdate = chain();
    const jobUpdate = chain();

    const pick = (table: string, repo: ChainBuilder, other: ChainBuilder) =>
      table.startsWith('repositories') ? repo : other;
    const trx = {
      insertInto: jest.fn((t: string) => pick(t, repoInsert, jobInsert)),
      updateTable: jest.fn((t: string) => pick(t, repoUpdate, jobUpdate)),
    };

    const db = {
      selectFrom: jest.fn((t: string) =>
        t.startsWith('backup_jobs as j')
          ? chain({ executeTakeFirst: jobRow })
          : chain({ executeTakeFirst: { backend_type: 'rest', id: 'x' } }),
      ),
      insertInto: jest.fn(() => chain()),
      deleteFrom: jest.fn(() => chain()),
      transaction: () => ({
        execute: (cb: (t: unknown) => Promise<unknown>) => cb(trx),
      }),
    } as unknown as Db;

    const acl = {
      assert: jest.fn().mockResolvedValue(undefined),
      can: jest.fn().mockResolvedValue(true),
    };
    const secrets = {
      create: jest.fn((type: string) =>
        Promise.resolve(type === 'repo_password' ? 'sec-password' : 'sec-cred'),
      ),
      update: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      reveal: jest
        .fn()
        .mockResolvedValue(JSON.stringify({ username: 'old-user', password: 'old-pw' })),
    };
    const service = new JobsService(
      db,
      acl as unknown as AccessControlService,
      secrets as unknown as SecretsService,
    );
    return { service, secrets, repoInsert, repoUpdate };
  }

  const createDto = {
    name: 'Daily',
    location: 'local' as const,
    paths: ['/data'],
    targetId: 't1',
    repoConfig: { path: 'repo' },
    repoPassword: 'pw',
    cronExpr: '0 3 * * *',
  };

  describe('create', () => {
    it('stores the credential override in its own encrypted secret', async () => {
      const { service, secrets, repoInsert } = make();

      await service.create(user, {
        ...createDto,
        repoCredentials: { username: 'job-user', password: 'job-pw' },
      });

      expect(secrets.create).toHaveBeenCalledWith(
        'backend_credential',
        JSON.stringify({ username: 'job-user', password: 'job-pw' }),
      );
      expect(repoInsert.values.mock.calls[0][0]).toMatchObject({
        credential_secret_id: 'sec-cred',
      });
    });

    it('leaves the override empty when the job supplies none', async () => {
      const { service, secrets, repoInsert } = make();

      await service.create(user, createDto);

      expect(secrets.create).toHaveBeenCalledTimes(1);
      expect(repoInsert.values.mock.calls[0][0]).toMatchObject({
        credential_secret_id: null,
      });
    });

    it('rejects a field the backend does not allow overriding', async () => {
      const { service } = make();

      await expect(
        service.create(user, { ...createDto, repoCredentials: { url: 'https://evil' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    it('merges a partial override into the existing secret', async () => {
      const { service, secrets } = make({ credential_secret_id: 'sec-old' });

      await service.update(user, 'job-1', { repoCredentials: { password: 'new-pw' } });

      expect(secrets.update).toHaveBeenCalledWith(
        'sec-old',
        JSON.stringify({ username: 'old-user', password: 'new-pw' }),
      );
      expect(secrets.create).not.toHaveBeenCalled();
    });

    it('creates the secret when the job had no override yet', async () => {
      const { service, secrets, repoUpdate } = make();

      await service.update(user, 'job-1', { repoCredentials: { username: 'u' } });

      expect(secrets.create).toHaveBeenCalledWith(
        'backend_credential',
        JSON.stringify({ username: 'u' }),
      );
      expect(repoUpdate.set.mock.calls[0][0]).toMatchObject({
        credential_secret_id: 'sec-cred',
      });
    });

    it('clears the override on null and deletes the secret', async () => {
      const { service, secrets, repoUpdate } = make({ credential_secret_id: 'sec-old' });

      await service.update(user, 'job-1', { repoCredentials: null });

      expect(repoUpdate.set.mock.calls[0][0]).toMatchObject({
        credential_secret_id: null,
      });
      expect(secrets.remove).toHaveBeenCalledWith('sec-old');
    });

    it('drops the override when the job moves to another connection', async () => {
      const { service, secrets, repoUpdate } = make({ credential_secret_id: 'sec-old' });

      await service.update(user, 'job-1', { targetId: 't2' });

      expect(repoUpdate.set.mock.calls[0][0]).toMatchObject({
        credential_secret_id: null,
      });
      expect(secrets.remove).toHaveBeenCalledWith('sec-old');
    });

    it('keeps the override when the connection is unchanged', async () => {
      const { service, secrets, repoUpdate } = make({ credential_secret_id: 'sec-old' });

      await service.update(user, 'job-1', { targetId: 't1', repoConfig: { path: 'other' } });

      expect(repoUpdate.set.mock.calls[0][0]).not.toHaveProperty('credential_secret_id');
      expect(secrets.remove).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes the override secret along with the job', async () => {
      const { service, secrets } = make({ credential_secret_id: 'sec-old' });

      await service.remove(user, 'job-1');

      expect(secrets.remove).toHaveBeenCalledWith('sec-password');
      expect(secrets.remove).toHaveBeenCalledWith('sec-old');
    });
  });
});
