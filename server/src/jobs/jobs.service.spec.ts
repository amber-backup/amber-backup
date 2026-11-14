import { BadRequestException, ForbiddenException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { JobsService } from './jobs.service';
import { AccessControlService } from '../common/access-control.service';
import { SecretsService } from '../crypto/secrets.service';
import { RequestUser } from '../common/auth/request-user';
import { Db } from '../database/database.module';
import { SettingsService } from '../settings/settings.service';
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
    const trxDeletes: Record<string, ChainBuilder> = {};
    const restoreUpdate = chain();
    const trx = {
      insertInto: jest.fn((t: string) => pick(t, repoInsert, jobInsert)),
      updateTable: jest.fn((t: string) =>
        t === 'restore_runs' ? restoreUpdate : pick(t, repoUpdate, jobUpdate),
      ),
      deleteFrom: jest.fn((t: string) => (trxDeletes[t] ??= chain())),
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
      { getTimezone: () => 'UTC' } as unknown as SettingsService,
    );
    return { service, secrets, repoInsert, repoUpdate, trx, trxDeletes, restoreUpdate };
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

    it('forbids a non-admin from creating a job (host-filesystem access)', async () => {
      const { service } = make();
      const nonAdmin = { id: 'u2', isAdmin: false } as RequestUser;

      await expect(service.create(nonAdmin, createDto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('update', () => {
    it('forbids a non-admin from changing paths/location/scripts', async () => {
      const { service } = make();
      const nonAdmin = { id: 'u2', isAdmin: false } as RequestUser;

      await expect(
        service.update(nonAdmin, 'job-1', { paths: ['/etc'] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a non-admin manager edit non-host fields', async () => {
      const { service } = make();
      const nonAdmin = { id: 'u2', isAdmin: false } as RequestUser;

      await expect(
        service.update(nonAdmin, 'job-1', { enabled: false }),
      ).resolves.toBeDefined();
    });

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

    it('forgets that the repository existed when it moves to another path', async () => {
      const { service, repoUpdate } = make();

      await service.update(user, 'job-1', { repoConfig: { path: 'elsewhere' } });

      expect(repoUpdate.set.mock.calls[0][0]).toMatchObject({
        initialized_at: null,
        relocated_at: expect.any(Date),
      });
    });

    it('forgets that the repository existed when it moves to another connection', async () => {
      const { service, repoUpdate } = make();

      await service.update(user, 'job-1', { targetId: 't2' });

      expect(repoUpdate.set.mock.calls[0][0]).toMatchObject({
        initialized_at: null,
        relocated_at: expect.any(Date),
      });
    });

    it('keeps what it knows when the same location is saved again', async () => {
      const { service, repoUpdate } = make();

      await service.update(user, 'job-1', { targetId: 't1', repoConfig: { path: 'repo' } });

      expect(repoUpdate.set.mock.calls[0][0]).not.toHaveProperty('relocated_at');
      expect(repoUpdate.set.mock.calls[0][0]).not.toHaveProperty('initialized_at');
    });
  });

  describe('remove', () => {
    it('deletes job, repository and both secrets in one transaction', async () => {
      const { service, trx, trxDeletes } = make({ credential_secret_id: 'sec-old' });

      await service.remove(user, 'job-1');

      expect(trx.deleteFrom.mock.calls.map((c) => c[0])).toEqual([
        'backup_jobs',
        'repositories',
        'secrets',
      ]);
      expect(trxDeletes.repositories.where).toHaveBeenCalledWith('id', '=', 'repo-1');
      expect(trxDeletes.secrets.where).toHaveBeenCalledWith('id', 'in', [
        'sec-password',
        'sec-old',
      ]);
    });

    it('fails restores of the job that have not started yet', async () => {
      const { service, restoreUpdate } = make();

      await service.remove(user, 'job-1');

      expect(restoreUpdate.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
      expect(restoreUpdate.where).toHaveBeenCalledWith('job_id', '=', 'job-1');
      expect(restoreUpdate.where).toHaveBeenCalledWith('status', '=', 'queued');
    });
  });
});

describe('JobsService.revealRepositoryPassword', () => {
  const admin = { id: 'u1', isAdmin: true, authVia: 'session' } as RequestUser;
  const job = { id: 'job-1', repo_password_secret_id: 'sec-password' };

  async function make(passwordHash: string | null) {
    const db = {
      selectFrom: jest.fn((t: string) =>
        t === 'users'
          ? chain({ executeTakeFirst: { password_hash: passwordHash } })
          : chain({ executeTakeFirst: job }),
      ),
    } as unknown as Db;
    const secrets = { reveal: jest.fn().mockResolvedValue('restic-secret') };
    const service = new JobsService(
      db,
      {} as AccessControlService,
      secrets as unknown as SecretsService,
      { getTimezone: () => 'UTC' } as unknown as SettingsService,
    );
    return { service, secrets };
  }

  it('reveals the password after the admin re-entered their own', async () => {
    const { service, secrets } = await make(await argon2.hash('login-pw'));

    await expect(service.revealRepositoryPassword(admin, 'job-1', 'login-pw')).resolves.toEqual({
      password: 'restic-secret',
    });
    expect(secrets.reveal).toHaveBeenCalledWith('sec-password');
  });

  it('refuses a wrong or missing current password', async () => {
    const { service, secrets } = await make(await argon2.hash('login-pw'));

    await expect(
      service.revealRepositoryPassword(admin, 'job-1', 'wrong'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.revealRepositoryPassword(admin, 'job-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(secrets.reveal).not.toHaveBeenCalled();
  });

  it('lets an SSO-only admin (no local password) reveal without one', async () => {
    const { service } = await make(null);

    await expect(service.revealRepositoryPassword(admin, 'job-1')).resolves.toEqual({
      password: 'restic-secret',
    });
  });

  it('is for administrator sessions only', async () => {
    const { service, secrets } = await make(null);

    await expect(
      service.revealRepositoryPassword({ ...admin, isAdmin: false }, 'job-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.revealRepositoryPassword({ ...admin, authVia: 'apikey' }, 'job-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(secrets.reveal).not.toHaveBeenCalled();
  });
});

describe('JobsService next run timezone', () => {
  function make(timezone: string) {
    const settings = { getTimezone: () => timezone };
    return new JobsService(
      {} as unknown as Db,
      {} as unknown as AccessControlService,
      {} as unknown as SecretsService,
      settings as unknown as SettingsService,
    );
  }

  it('reads a cron expression in the configured timezone', () => {
    // "03:00 daily" is a different instant in Berlin than it is in UTC.
    const utc = make('UTC').nextRun('0 3 * * *')!;
    const berlin = make('Europe/Berlin').nextRun('0 3 * * *')!;

    expect(utc.getUTCHours()).toBe(3);
    // Berlin is one or two hours ahead, depending on daylight saving time.
    expect([1, 2]).toContain(berlin.getUTCHours());
  });

  it('returns null for an expression it cannot parse', () => {
    expect(make('UTC').nextRun('not a cron')).toBeNull();
  });

  // The scheduler (`cron`) rejects these; cron-parser used to accept them, so
  // such a job was saved, showed a next run, and never ran.
  it.each(['0 0 L * *', '0 0 * * 5L', '0 0 * * 1#2', '0 0 ? * *', '0 0 31 2 *'])(
    'reports %s as unschedulable and shows no next run',
    (expr) => {
      const service = make('UTC');
      expect(service.scheduleError(expr)).toEqual(expect.any(String));
      expect(service.nextRun(expr)).toBeNull();
    },
  );

  it('accepts what the scheduler runs', () => {
    const service = make('Europe/Berlin');
    for (const expr of ['0 3 * * *', '*/15 * * * *', '0 2 * * 1-5', '@daily']) {
      expect(service.scheduleError(expr)).toBeNull();
      expect(service.nextRun(expr)).toBeInstanceOf(Date);
    }
  });
});
