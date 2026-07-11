import * as argon2 from 'argon2';
import { chain, createDbMock } from '../testing/db-mock';
import { UsersService } from './users.service';
import { User } from '../database/database.types';

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
      const service = new UsersService(db);
      const user = makeUser({ password_hash: await argon2.hash('correct horse') });
      await expect(service.verifyPassword(user, 'correct horse')).resolves.toBe(
        true,
      );
    });

    it('rejects a wrong password', async () => {
      const { db } = createDbMock({});
      const service = new UsersService(db);
      const user = makeUser({ password_hash: await argon2.hash('correct horse') });
      await expect(service.verifyPassword(user, 'wrong')).resolves.toBe(false);
    });

    it('returns false when the user has no password hash (SSO account)', async () => {
      const { db } = createDbMock({});
      const service = new UsersService(db);
      await expect(
        service.verifyPassword(makeUser({ password_hash: null }), 'anything'),
      ).resolves.toBe(false);
    });

    it('returns false (no throw) on a malformed hash', async () => {
      const { db } = createDbMock({});
      const service = new UsersService(db);
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
      const service = new UsersService(db);

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
      const service = new UsersService(db);

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

  describe('changePassword', () => {
    it('rejects a wrong current password', async () => {
      const row = makeUser({ id: 'u1', password_hash: await argon2.hash('right') });
      const { db } = createDbMock({ selectFrom: chain({ executeTakeFirst: row }) });
      const service = new UsersService(db);

      await expect(
        service.changePassword('u1', 'wrong', 'newlongpassword'),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('refuses to change an SSO account password', async () => {
      const row = makeUser({ id: 'u1', auth_source: 'oidc' });
      const { db } = createDbMock({ selectFrom: chain({ executeTakeFirst: row }) });
      const service = new UsersService(db);

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
      const service = new UsersService(db);

      await service.changePassword('u1', 'oldpw', 'brandnewpw');

      const patch = update.set.mock.calls[0][0] as { password_hash: string };
      expect(patch.password_hash).toMatch(/^\$argon2/);
      await expect(argon2.verify(patch.password_hash, 'brandnewpw')).resolves.toBe(true);
    });
  });
});
