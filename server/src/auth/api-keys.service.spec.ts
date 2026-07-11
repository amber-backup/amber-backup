import { chain, createDbMock, TEST_MASTER_KEY } from '../testing/db-mock';

process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;

import { CryptoService } from '../crypto/crypto.service';
import { ApiKeysService } from './api-keys.service';
import { API_KEY_PREFIX } from '../common/guards/auth.guard';

describe('ApiKeysService (key generation & hashing)', () => {
  let crypto: CryptoService;

  beforeEach(() => {
    process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;
    crypto = new CryptoService();
  });

  function serviceWithInsertCapture() {
    const insert = chain({
      executeTakeFirstOrThrow: { id: 'key-1', name: 'CI', prefix: 'ak_xxxxxxxx' },
    });
    const { db } = createDbMock({ insertInto: insert });
    return { service: new ApiKeysService(db, crypto), insert };
  }

  it('returns a plaintext key with the ak_ prefix, storing the display prefix', async () => {
    const { service, insert } = serviceWithInsertCapture();
    const result = await service.create('user-1', { name: 'CI' });
    expect(result.key.startsWith(API_KEY_PREFIX)).toBe(true);
    const stored = insert.values.mock.calls[0][0] as { prefix: string };
    expect(stored.prefix).toBe(result.key.slice(0, 12));
  });

  it('persists only the SHA-256 hash of the key, never the plaintext', async () => {
    const { service, insert } = serviceWithInsertCapture();
    const result = await service.create('user-1', { name: 'CI' });

    const stored = insert.values.mock.calls[0][0] as {
      key_hash: string;
      prefix: string;
      user_id: string;
    };
    expect(stored.key_hash).toBe(crypto.hashToken(result.key));
    expect(stored.key_hash).not.toBe(result.key);
    expect(stored.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.user_id).toBe('user-1');
  });

  it('defaults to a wildcard action scope', async () => {
    const { service, insert } = serviceWithInsertCapture();
    await service.create('user-1', { name: 'CI' });
    const stored = insert.values.mock.calls[0][0] as { scopes: string };
    expect(JSON.parse(stored.scopes)).toEqual({ actions: ['*'] });
  });

  it('stores no expiry when expiresInDays is absent', async () => {
    const { service, insert } = serviceWithInsertCapture();
    await service.create('user-1', { name: 'CI' });
    const stored = insert.values.mock.calls[0][0] as { expires_at: Date | null };
    expect(stored.expires_at).toBeNull();
  });

  it('generates distinct keys across calls', async () => {
    const { service } = serviceWithInsertCapture();
    const a = await service.create('user-1', { name: 'a' });
    const b = await service.create('user-1', { name: 'b' });
    expect(a.key).not.toBe(b.key);
  });
});
