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

  it('encrypts a provider client secret at rest (never stores plaintext)', async () => {
    const { db, raw } = createStore();
    const service = new SettingsService(db, crypto);

    await service.updateSso({
      enabled: true,
      providers: [
        {
          type: 'oidc',
          issuerUrl: 'https://id.example.com',
          clientId: 'client-abc',
          clientSecret: 'super-secret',
        },
      ],
    });

    const stored = JSON.parse(raw.get(SETTINGS_KEYS.sso)!);
    expect(stored.enabled).toBe(true);
    expect(stored.providers).toHaveLength(1);
    expect(stored.providers[0].secret).toMatchObject({
      ciphertext: expect.any(String),
      nonce: expect.any(String),
    });
    // A stable id is assigned to the new provider.
    expect(typeof stored.providers[0].id).toBe('string');
    expect(stored.providers[0].id.length).toBeGreaterThan(0);
    // Plaintext must not appear anywhere in the serialized settings.
    expect(raw.get(SETTINGS_KEYS.sso)).not.toContain('super-secret');
    // And it decrypts back to the original.
    expect(crypto.decrypt(stored.providers[0].secret as EncryptedPayload)).toBe(
      'super-secret',
    );
  });

  it('supports multiple providers of different types', async () => {
    const { db } = createStore();
    const service = new SettingsService(db, crypto);
    await service.updateSso({
      enabled: true,
      providers: [
        { type: 'entra', tenantId: 't1', clientId: 'e', clientSecret: 'es' },
        { type: 'github', clientId: 'g', clientSecret: 'gs' },
      ],
    });

    const resolved = await service.getResolvedSso();
    expect(resolved.enabled).toBe(true);
    expect(resolved.providers.map((p) => p.type)).toEqual(['entra', 'github']);
    expect(resolved.providers[0].clientSecret).toBe('es');
    expect(resolved.providers[1].clientSecret).toBe('gs');
  });

  it('leaves a provider secret unchanged when clientSecret is blank', async () => {
    const { db, raw } = createStore();
    const service = new SettingsService(db, crypto);

    await service.updateSso({
      enabled: true,
      providers: [{ type: 'oidc', clientId: 'c1', clientSecret: 'first-secret' }],
    });
    const firstBlob = JSON.parse(raw.get(SETTINGS_KEYS.sso)!);
    const id = firstBlob.providers[0].id as string;

    // Re-save the same provider (by id) with other fields changed, secret blank.
    await service.updateSso({
      enabled: true,
      providers: [{ id, type: 'oidc', clientId: 'c2', clientSecret: '' }],
    });

    const resolved = await service.getResolvedSso();
    expect(resolved.providers[0].clientId).toBe('c2');
    expect(resolved.providers[0].clientSecret).toBe('first-secret');
    // The ciphertext for the secret is preserved (not re-encrypted to empty).
    const after = JSON.parse(raw.get(SETTINGS_KEYS.sso)!).providers[0].secret;
    expect(after).toEqual(firstBlob.providers[0].secret);
  });

  it('removes providers absent from the update', async () => {
    const { db } = createStore();
    const service = new SettingsService(db, crypto);
    await service.updateSso({
      enabled: true,
      providers: [
        { type: 'oidc', clientId: 'a', clientSecret: 's', issuerUrl: 'https://a' },
        { type: 'google', clientId: 'b', clientSecret: 's' },
      ],
    });
    await service.updateSso({ enabled: true, providers: [] });
    const resolved = await service.getResolvedSso();
    expect(resolved.providers).toHaveLength(0);
  });

  it('never exposes secrets in the admin view — only a "set" flag', async () => {
    const { db } = createStore();
    const service = new SettingsService(db, crypto);
    await service.updateSso({
      enabled: true,
      providers: [{ type: 'oidc', clientId: 'c1', clientSecret: 'hidden' }],
    });

    const view = await service.getSystemView();
    expect(view.sso.enabled).toBe(true);
    expect(view.sso.providers[0].clientSecretSet).toBe(true);
    expect(JSON.stringify(view)).not.toContain('hidden');
    expect((view.sso.providers[0] as any).secret).toBeUndefined();
    expect((view.sso.providers[0] as any).clientSecret).toBeUndefined();
  });

  it('migrates the legacy fixed oidc/entra shape into providers', async () => {
    const { db, raw } = createStore();
    const service = new SettingsService(db, crypto);
    // Seed a legacy-format value directly.
    const legacySecret = crypto.encrypt('legacy');
    raw.set(
      SETTINGS_KEYS.sso,
      JSON.stringify({
        oidc: { enabled: true, issuerUrl: 'https://l', clientId: 'lc', secret: legacySecret },
      }),
    );

    const resolved = await service.getResolvedSso();
    expect(resolved.enabled).toBe(true);
    expect(resolved.providers).toHaveLength(1);
    expect(resolved.providers[0].type).toBe('oidc');
    expect(resolved.providers[0].clientSecret).toBe('legacy');
  });
});
