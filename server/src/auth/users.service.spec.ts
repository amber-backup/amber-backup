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
});
