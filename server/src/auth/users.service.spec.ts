import * as argon2 from 'argon2';
import { chain, createDbMock } from '../testing/db-mock';
import { UsersService } from './users.service';
import { SettingsService } from '../settings/settings.service';
import { User } from '../database/database.types';

/** Only `hasUsableSso` is reached from UsersService. */
const settingsStub = (usableSso = true): SettingsService =>
  ({ hasUsableSso: jest.fn().mockResolvedValue(usableSso) }) as unknown as SettingsService;

describe('UsersService (password hashing with Argon2)', () => {
  function makeUser(overrides: Partial<User> = {}): User {
    return {
      password_hash: null,
      auth_source: 'local',
      disabled: false,
      ...overrides,
    } as User;
  }

  describe('verifyPassword', () => {
    it('accepts the correct password against an Argon2 hash', async () => {
      const { db } = createDbMock({});
      const service = new UsersService(db, settingsStub());
      const user = makeUser({ password_hash: await argon2.hash('correct horse') });
      await expect(service.verifyPassword(user, 'correct horse')).resolves.toBe(
        true,
      );
    });

    it('rejects a wrong password', async () => {
      const { db } = createDbMock({});
      const service = new UsersService(db, settingsStub());
      const user = makeUser({ password_hash: await argon2.hash('correct horse') });
      await expect(service.verifyPassword(user, 'wrong')).resolves.toBe(false);
    });

    it('returns false when the user has no password hash (SSO account)', async () => {
      const { db } = createDbMock({});
      const service = new UsersService(db, settingsStub());
      await expect(
        service.verifyPassword(makeUser({ password_hash: null }), 'anything'),
      ).resolves.toBe(false);
    });

    it('returns false (no throw) on a malformed hash', async () => {
      const { db } = createDbMock({});
      const service = new UsersService(db, settingsStub());
      await expect(
        service.verifyPassword(makeUser({ password_hash: 'not-a-hash' }), 'x'),
      ).resolves.toBe(false);
    });
  });

  describe('updatePreferences', () => {
    it('stores the chosen locale and returns the public user', async () => {
      const update = chain();
      const select = chain({
        executeTakeFirst: makeUser({ id: 'u1', locale: 'de', password_hash: 'h' }),
      });
      const { db } = createDbMock({ selectFrom: select, updateTable: update });
      const service = new UsersService(db, settingsStub());

      const result = await service.updatePreferences('u1', { locale: 'de' });

      expect(update.set.mock.calls[0][0]).toMatchObject({ locale: 'de' });
      expect(result.locale).toBe('de');
      expect(result).not.toHaveProperty('password_hash');
    });

    it('resets to browser language with null', async () => {
      const update = chain();
      const select = chain({ executeTakeFirst: makeUser({ id: 'u1' }) });
      const { db } = createDbMock({ selectFrom: select, updateTable: update });
      const service = new UsersService(db, settingsStub());

      await service.updatePreferences('u1', { locale: null });

      expect(update.set.mock.calls[0][0]).toMatchObject({ locale: null });
    });

    it('leaves the row untouched when nothing is given', async () => {
      const update = chain();
      const select = chain({ executeTakeFirst: makeUser({ id: 'u1' }) });
      const { db, updateTable } = createDbMock({ selectFrom: select, updateTable: update });
      const service = new UsersService(db, settingsStub());

      await service.updatePreferences('u1', {});

      expect(updateTable).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('stores a verifiable Argon2 hash, never the plaintext password', async () => {
      const select = chain({ executeTakeFirst: undefined }); // no existing email
      const insert = chain({
        executeTakeFirstOrThrow: {
          id: 'u1',
          email: 'a@example.com',
          password_hash: '$argon2id$stored',
        },
      });
      const { db } = createDbMock({ selectFrom: select, insertInto: insert });
      const service = new UsersService(db, settingsStub());

      await service.create(
        { email: 'A@Example.com', displayName: 'A', password: 's3cret' },
        'local',
      );

      const stored = insert.values.mock.calls[0][0] as {
        email: string;
        password_hash: string;
      };
      expect(stored.email).toBe('a@example.com'); // normalised
      expect(stored.password_hash).toMatch(/^\$argon2/);
      expect(stored.password_hash).not.toContain('s3cret');
      await expect(argon2.verify(stored.password_hash, 's3cret')).resolves.toBe(
        true,
      );
    });

    it('does not hash a password for SSO accounts', async () => {
      const select = chain({ executeTakeFirst: undefined });
      const insert = chain({
        executeTakeFirstOrThrow: { id: 'u2', email: 'sso@example.com' },
      });
      const { db } = createDbMock({ selectFrom: select, insertInto: insert });
      const service = new UsersService(db, settingsStub());

      await service.create(
        { email: 'sso@example.com', displayName: 'SSO', password: '' },
        'oidc',
      );

      const stored = insert.values.mock.calls[0][0] as {
        password_hash: string | null;
        disabled: boolean;
      };
      expect(stored.password_hash).toBeNull();
      expect(stored.disabled).toBe(true); // SSO users start disabled
    });
  });

  describe('update — switching an account between local and SSO', () => {
    function setup(user: User, usableSso = true) {
      const update = chain({ executeTakeFirstOrThrow: { ...user, id: 'u1' } });
      const { db } = createDbMock({
        selectFrom: chain({ executeTakeFirst: user }),
        updateTable: update,
      });
      return {
        service: new UsersService(db, settingsStub(usableSso)),
        patchOf: () => update.set.mock.calls[0][0] as Record<string, unknown>,
      };
    }

    it('clears the password and the local second factor when moving to SSO', async () => {
      const { service, patchOf } = setup(
        makeUser({ id: 'u1', password_hash: '$argon2id$x', totp_enabled: true }),
      );

      await service.update('u1', { authSource: 'sso' });

      expect(patchOf()).toMatchObject({
        auth_source: 'sso',
        password_hash: null,
        totp_enabled: false,
        totp_secret_ciphertext: null,
        totp_secret_nonce: null,
        totp_recovery_codes: null,
      });
    });

    it('refuses to move to SSO while no provider could serve a login', async () => {
      const { service } = setup(makeUser({ id: 'u1' }), false);

      await expect(
        service.update('u1', { authSource: 'sso' }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('refuses to move back to local without a password', async () => {
      const { service } = setup(makeUser({ id: 'u1', auth_source: 'sso' }));

      await expect(
        service.update('u1', { authSource: 'local' }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('sets a verifiable hash when moving back to local with a password', async () => {
      const { service, patchOf } = setup(makeUser({ id: 'u1', auth_source: 'sso' }));

      await service.update('u1', { authSource: 'local', password: 'brandnewpw' });

      const patch = patchOf() as { auth_source: string; password_hash: string };
      expect(patch.auth_source).toBe('local');
      await expect(argon2.verify(patch.password_hash, 'brandnewpw')).resolves.toBe(true);
    });

    it('still refuses a password on an account that stays on SSO', async () => {
      const { service } = setup(makeUser({ id: 'u1', auth_source: 'entra' }));

      await expect(
        service.update('u1', { password: 'brandnewpw' }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('changePassword', () => {
    it('rejects a wrong current password', async () => {
      const row = makeUser({ id: 'u1', password_hash: await argon2.hash('right') });
      const { db } = createDbMock({ selectFrom: chain({ executeTakeFirst: row }) });
      const service = new UsersService(db, settingsStub());

      await expect(
        service.changePassword('u1', 'wrong', 'newlongpassword'),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('refuses to change an SSO account password', async () => {
      const row = makeUser({ id: 'u1', auth_source: 'oidc' });
      const { db } = createDbMock({ selectFrom: chain({ executeTakeFirst: row }) });
      const service = new UsersService(db, settingsStub());

      await expect(
        service.changePassword('u1', 'whatever', 'newlongpassword'),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('stores a new verifiable Argon2 hash on success', async () => {
      const row = makeUser({ id: 'u1', password_hash: await argon2.hash('oldpw') });
      const update = chain({ execute: [] });
      const { db } = createDbMock({
        selectFrom: chain({ executeTakeFirst: row }),
        updateTable: update,
      });
      const service = new UsersService(db, settingsStub());

      await service.changePassword('u1', 'oldpw', 'brandnewpw');

      const patch = update.set.mock.calls[0][0] as { password_hash: string };
      expect(patch.password_hash).toMatch(/^\$argon2/);
      await expect(argon2.verify(patch.password_hash, 'brandnewpw')).resolves.toBe(true);
    });
  });

  describe('last-admin protection', () => {
    const admin = { id: 'a1', is_admin: true, disabled: false };
    // db mock whose selectFrom returns each configured result in order.
    function dbReturning(results: unknown[]) {
      let call = 0;
      const db = {
        selectFrom: jest.fn(() =>
          chain({ executeTakeFirst: results[Math.min(call++, results.length - 1)] }),
        ),
        updateTable: jest.fn(() =>
          chain({
            execute: [],
            executeTakeFirstOrThrow: { id: 'a1', is_admin: false, disabled: false },
          }),
        ),
        deleteFrom: jest.fn(() => chain({ execute: [] })),
      };
      return db as unknown as import('../database/database.module').Db;
    }

    // update() selects: user load, then isLastActiveAdmin's target + others.
    it('refuses to demote the last remaining admin', async () => {
      const service = new UsersService(
        dbReturning([admin, admin, undefined]),
        settingsStub(),
      );
      await expect(
        service.update('a1', { isAdmin: false }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('refuses to disable the last remaining admin', async () => {
      const service = new UsersService(
        dbReturning([admin, admin, undefined]),
        settingsStub(),
      );
      await expect(
        service.update('a1', { disabled: true }),
      ).rejects.toMatchObject({ status: 400 });
    });

    // remove() selects: isLastActiveAdmin's target + others.
    it('refuses to delete the last remaining admin', async () => {
      const service = new UsersService(
        dbReturning([admin, undefined]),
        settingsStub(),
      );
      await expect(service.remove('a1')).rejects.toMatchObject({ status: 400 });
    });

    it('allows demoting an admin when another active admin exists', async () => {
      const service = new UsersService(
        dbReturning([admin, admin, { id: 'a2' }]),
        settingsStub(),
      );
      await expect(service.update('a1', { isAdmin: false })).resolves.toBeDefined();
    });
  });
});
