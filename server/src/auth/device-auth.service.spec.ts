import { chain, createDbMock, TEST_MASTER_KEY } from '../testing/db-mock';

process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;

import { NotFoundException } from '@nestjs/common';
import { CryptoService } from '../crypto/crypto.service';
import { Db } from '../database/database.module';
import { RequestUser } from '../common/auth/request-user';
import {
  DeviceAuthService,
  formatUserCode,
  generateUserCode,
  normalizeUserCode,
} from './device-auth.service';

const ctx = { ip: '203.0.113.7', userAgent: 'ambb/1.0.0' };
const session: RequestUser = {
  id: 'user-1',
  email: 'a@example.com',
  isAdmin: false,
  authVia: 'session',
};

describe('DeviceAuthService', () => {
  let crypto: CryptoService;
  const audit = { record: jest.fn() };

  beforeEach(() => {
    crypto = new CryptoService();
    audit.record.mockReset();
  });

  function service(db: Db, apiKeys: Record<string, jest.Mock> = {}) {
    return new DeviceAuthService(db, crypto, apiKeys as never, audit as never);
  }

  describe('user codes', () => {
    it('are 8 unambiguous consonants, displayed as XXXX-XXXX', () => {
      for (let i = 0; i < 50; i++) {
        const code = generateUserCode();
        expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
        expect(normalizeUserCode(formatUserCode(code))).toBe(code);
      }
    });

    it('normalize case, dashes and spaces and reject anything else', () => {
      expect(normalizeUserCode(' bcdf-ghjk ')).toBe('BCDFGHJK');
      expect(normalizeUserCode('BCDF-GHJ0')).toBeNull();
      expect(normalizeUserCode('BCDFGHJKL')).toBeNull();
      expect(normalizeUserCode("' OR 1=1")).toBeNull();
    });
  });

  it('stores only hashes of both codes', async () => {
    const insert = chain();
    const { db } = createDbMock({ insertInto: insert });

    const res = await service(db).requestCode('laptop', ctx);

    const stored = insert.values.mock.calls[0][0] as Record<string, unknown>;
    const userCode = normalizeUserCode(res.userCode)!;
    expect(stored.device_code_hash).toBe(crypto.hashToken(res.deviceCode));
    expect(stored.user_code_hash).toBe(crypto.hashToken(userCode));
    expect(JSON.stringify(stored)).not.toContain(res.deviceCode);
    expect(JSON.stringify(stored)).not.toContain(userCode);
    expect(res.verificationPath).toBe(`/#/device?code=${res.userCode}`);
    expect(res.deviceCode.length).toBeGreaterThanOrEqual(43);
  });

  describe('exchange', () => {
    const future = () => new Date(Date.now() + 60_000);

    it('reports unknown, consumed and expired codes all as expired', async () => {
      for (const row of [
        undefined,
        { id: 'd', status: 'consumed', expires_at: future(), last_polled_at: null },
        { id: 'd', status: 'approved', expires_at: new Date(Date.now() - 1), last_polled_at: null },
      ]) {
        const { db } = createDbMock({ selectFrom: chain({ executeTakeFirst: row }) });
        await expect(service(db).exchange('x'.repeat(43), ctx)).resolves.toEqual({
          status: 'expired',
        });
      }
    });

    it('asks a client polling faster than the interval to slow down', async () => {
      const update = chain();
      const { db } = createDbMock({
        selectFrom: chain({
          executeTakeFirst: {
            id: 'd',
            status: 'pending',
            expires_at: future(),
            last_polled_at: new Date(Date.now() - 1000),
          },
        }),
        updateTable: update,
      });
      await expect(service(db).exchange('x'.repeat(43), ctx)).resolves.toEqual({
        status: 'slow_down',
      });
      expect(update.set).toHaveBeenCalled();
    });

    it('mints a read-only key exactly once on an approved pairing', async () => {
      const claim = chain({
        executeTakeFirst: {
          user_id: 'user-1',
          client_name: 'laptop',
          access: 'read',
          key_expires_in_days: 30,
        },
      });
      const trx = {
        updateTable: jest.fn().mockReturnValueOnce(claim).mockReturnValue(chain()),
        selectFrom: jest.fn(() =>
          chain({
            executeTakeFirst: { id: 'user-1', email: 'a@example.com', is_admin: true, disabled: false },
          }),
        ),
      };
      const db = {
        selectFrom: jest.fn(() =>
          chain({
            executeTakeFirst: { id: 'd', status: 'approved', expires_at: future(), last_polled_at: null },
          }),
        ),
        transaction: () => ({ execute: (cb: (t: unknown) => Promise<unknown>) => cb(trx) }),
      } as unknown as Db;
      const apiKeys = {
        create: jest.fn().mockResolvedValue({
          id: 'key-1',
          name: 'CLI: laptop',
          prefix: 'ak_abcdefghi',
          key: 'ak_secret',
          expiresAt: null,
        }),
      };

      const res = await service(db, apiKeys).exchange('x'.repeat(43), ctx);

      expect(res).toMatchObject({ status: 'approved', apiKey: 'ak_secret', access: 'read' });
      // The claim is conditional on the row still being approved.
      expect(claim.where).toHaveBeenCalledWith('status', '=', 'approved');
      expect(claim.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'consumed' }));
      expect(apiKeys.create).toHaveBeenCalledWith(
        'user-1',
        { name: 'CLI: laptop', scopes: { actions: ['read'] }, expiresInDays: 30 },
        trx,
      );
      // The plaintext key never reaches the audit log.
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain('ak_secret');
    });

    it('issues nothing when a concurrent poll already claimed the pairing', async () => {
      const trx = { updateTable: jest.fn(() => chain({ executeTakeFirst: undefined })) };
      const db = {
        selectFrom: jest.fn(() =>
          chain({
            executeTakeFirst: { id: 'd', status: 'approved', expires_at: future(), last_polled_at: null },
          }),
        ),
        transaction: () => ({ execute: (cb: (t: unknown) => Promise<unknown>) => cb(trx) }),
      } as unknown as Db;
      const apiKeys = { create: jest.fn() };

      await expect(service(db, apiKeys).exchange('x'.repeat(43), ctx)).resolves.toEqual({
        status: 'expired',
      });
      expect(apiKeys.create).not.toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it('only transitions a pending, unexpired pairing', async () => {
      const update = chain({ executeTakeFirst: { numUpdatedRows: 1n } });
      const { db } = createDbMock({ updateTable: update });

      await service(db).approve(session, { userCode: 'bcdf-ghjk', access: 'full' });

      expect(update.where).toHaveBeenCalledWith('user_code_hash', '=', crypto.hashToken('BCDFGHJK'));
      expect(update.where).toHaveBeenCalledWith('status', '=', 'pending');
      expect(update.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'approved', user_id: 'user-1', access: 'full' }),
      );
    });

    it('rejects unknown or malformed codes', async () => {
      const update = chain({ executeTakeFirst: { numUpdatedRows: 0n } });
      const { db } = createDbMock({ updateTable: update });
      await expect(
        service(db).approve(session, { userCode: 'BCDF-GHJK', access: 'full' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service(db).approve(session, { userCode: 'nope', access: 'full' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('lets only an API key revoke itself', async () => {
    const apiKeys = { remove: jest.fn() };
    const { db } = createDbMock({});
    await expect(service(db, apiKeys).revokeCurrentKey(session)).rejects.toThrow();
    await service(db, apiKeys).revokeCurrentKey({ ...session, authVia: 'apikey', apiKeyId: 'key-9' });
    expect(apiKeys.remove).toHaveBeenCalledWith('user-1', 'key-9');
  });
});
