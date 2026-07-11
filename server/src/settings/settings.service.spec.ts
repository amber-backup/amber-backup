/* eslint-disable @typescript-eslint/no-explicit-any */
import { TEST_MASTER_KEY } from '../testing/db-mock';

process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;

import { CryptoService, EncryptedPayload } from '../crypto/crypto.service';
import { Db } from '../database/database.module';
import { SettingsService, SETTINGS_KEYS } from './settings.service';

/**
 * Stateful in-memory stand-in for the `app_settings` key/value table so that
 * read-after-write works within a test. Values are stored as JSON strings,
 * exactly as the service writes jsonb.
 */
function createStore(): { db: Db; raw: Map<string, string> } {
  const raw = new Map<string, string>();

  const insertInto = () => {
    let pending: { key: string; value: string } | null = null;
    const builder: any = {
      values: (v: { key: string; value: string }) => {
        pending = { key: v.key, value: v.value };
        return builder;
      },
      onConflict: () => builder,
      execute: () => {
        if (pending) raw.set(pending.key, pending.value);
        return Promise.resolve([]);
      },
    };
    return builder;
  };

  const selectFrom = () => {
    let key: string | null = null;
    const builder: any = {
      select: () => builder,
      where: (_col: string, _op: string, value: string) => {
        key = value;
        return builder;
      },
      executeTakeFirst: () =>
        Promise.resolve(
          key !== null && raw.has(key) ? { value: raw.get(key) } : undefined,
        ),
    };
    return builder;
  };

  const db = { insertInto, selectFrom } as unknown as Db;
  return { db, raw };
}

describe('SettingsService (SSO secret encryption)', () => {
  let crypto: CryptoService;

  beforeEach(() => {
    process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;
    crypto = new CryptoService();
  });

  it('defaults the agent offline timeout to 120s and round-trips a new value', async () => {
    const { db } = createStore();
    const service = new SettingsService(db, crypto);
    expect(await service.getAgentOfflineTimeout()).toBe(120);
    await service.setAgentOfflineTimeout(300);
    expect(await service.getAgentOfflineTimeout()).toBe(300);
  });

  it('encrypts the OIDC client secret at rest (never stores plaintext)', async () => {
    const { db, raw } = createStore();
    const service = new SettingsService(db, crypto);

    await service.updateSso({
      oidc: {
        enabled: true,
        issuerUrl: 'https://id.example.com',
        clientId: 'client-abc',
        clientSecret: 'super-secret',
      },
    });

    const stored = JSON.parse(raw.get(SETTINGS_KEYS.sso)!);
    expect(stored.oidc.secret).toMatchObject({
      ciphertext: expect.any(String),
      nonce: expect.any(String),
    });
    // Plaintext must not appear anywhere in the serialized settings.
    expect(raw.get(SETTINGS_KEYS.sso)).not.toContain('super-secret');
    // And it decrypts back to the original.
    expect(crypto.decrypt(stored.oidc.secret as EncryptedPayload)).toBe('super-secret');
  });

  it('decrypts secrets in getResolvedSso for internal use', async () => {
    const { db } = createStore();
    const service = new SettingsService(db, crypto);
    await service.updateSso({
      entra: {
        enabled: true,
        tenantId: 'tenant-1',
        clientId: 'entra-client',
        clientSecret: 'entra-secret',
      },
    });

    const resolved = await service.getResolvedSso();
    expect(resolved.entra.enabled).toBe(true);
    expect(resolved.entra.clientSecret).toBe('entra-secret');
    expect(resolved.oidc.clientSecret).toBe('');
  });

  it('leaves the stored secret unchanged when clientSecret is blank', async () => {
    const { db, raw } = createStore();
    const service = new SettingsService(db, crypto);

    await service.updateSso({
      oidc: { enabled: true, clientId: 'c1', clientSecret: 'first-secret' },
    });
    const firstBlob = raw.get(SETTINGS_KEYS.sso);

    // Update other fields but leave the secret blank.
    await service.updateSso({
      oidc: { enabled: true, clientId: 'c2', clientSecret: '' },
    });

    const resolved = await service.getResolvedSso();
    expect(resolved.oidc.clientId).toBe('c2');
    expect(resolved.oidc.clientSecret).toBe('first-secret');
    // The ciphertext for the secret is preserved (not re-encrypted to empty).
    const before = JSON.parse(firstBlob!).oidc.secret;
    const after = JSON.parse(raw.get(SETTINGS_KEYS.sso)!).oidc.secret;
    expect(after).toEqual(before);
  });

  it('never exposes secrets in the admin view — only a "set" flag', async () => {
    const { db } = createStore();
    const service = new SettingsService(db, crypto);
    await service.updateSso({
      oidc: { enabled: true, clientId: 'c1', clientSecret: 'hidden' },
    });

    const view = await service.getSystemView();
    expect(view.sso.oidc.clientSecretSet).toBe(true);
    expect(view.sso.entra.clientSecretSet).toBe(false);
    expect(JSON.stringify(view)).not.toContain('hidden');
    expect((view.sso.oidc as any).clientSecret).toBeUndefined();
  });
});
