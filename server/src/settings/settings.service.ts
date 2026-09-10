import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Db, KYSELY } from '../database/database.module';
import { CryptoService, EncryptedPayload } from '../crypto/crypto.service';
import { loadConfig } from '../config/configuration';

/**
 * Runtime-configurable settings, stored in the `app_settings` table so admins
 * can change them in the UI (instead of env vars / restarts). SSO client
 * secrets are encrypted at rest like any other credential.
 */

export const SETTINGS_KEYS = {
  agentOfflineTimeout: 'agent_offline_timeout',
  sso: 'sso',
  localLogin: 'local_login',
} as const;

const DEFAULT_OFFLINE_SECONDS = 120;

/** Supported single sign-on provider kinds. */
export type SsoProviderType = 'oidc' | 'entra' | 'google' | 'github';
export const SSO_PROVIDER_TYPES: SsoProviderType[] = [
  'oidc',
  'entra',
  'google',
  'github',
];

interface StoredProvider {
  id: string;
  type: SsoProviderType;
  /** Optional label override for the login button. */
  label: string;
  clientId: string;
  /** OIDC only: issuer base URL. */
  issuerUrl: string;
  /** Entra only: directory (tenant) id. */
  tenantId: string;
  secret: EncryptedPayload | null;
}
interface StoredSso {
  enabled: boolean;
  providers: StoredProvider[];
}

/** A single provider with its secret decrypted, for the SSO service. */
export interface ResolvedProvider {
  id: string;
  type: SsoProviderType;
  label: string;
  clientId: string;
  clientSecret: string;
  issuerUrl: string;
  tenantId: string;
}
export interface ResolvedSso {
  enabled: boolean;
  providers: ResolvedProvider[];
}

/** Admin-facing provider update; a blank clientSecret keeps the stored one. */
export interface SsoProviderUpdate {
  /** Present when editing an existing provider (preserves its secret). */
  id?: string;
  type: SsoProviderType;
  label?: string;
  clientId?: string;
  issuerUrl?: string;
  tenantId?: string;
  clientSecret?: string;
}
export interface SsoUpdate {
  enabled?: boolean;
  providers?: SsoProviderUpdate[];
}

/** Masked provider for the admin view (secret replaced by a "set" flag). */
export interface SsoProviderView {
  id: string;
  type: SsoProviderType;
  label: string;
  clientId: string;
  issuerUrl: string;
  tenantId: string;
  clientSecretSet: boolean;
}

/** Admin-facing view (secrets never leave the server — only a "set" flag). */
export interface SystemSettingsView {
  agentOfflineTimeoutSeconds: number;
  /** Whether password and passkey logins are accepted at all. */
  localLoginEnabled: boolean;
  sso: {
    enabled: boolean;
    providers: SsoProviderView[];
  };
  /** Redirect URI to register with the identity provider. */
  ssoRedirectUri: string;
}

const EMPTY_SSO: StoredSso = { enabled: false, providers: [] };

@Injectable()
export class SettingsService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly crypto: CryptoService,
  ) {}

  private async read<T>(key: string): Promise<T | null> {
    const row = await this.db
      .selectFrom('app_settings')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();
    if (!row || row.value == null) return null;
    return (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) as T;
  }

  private async write(key: string, value: unknown): Promise<void> {
    await this.db
      .insertInto('app_settings')
      .values({ key, value: JSON.stringify(value), updated_at: new Date() })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({
          value: JSON.stringify(value),
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  // --- Agent offline timeout ------------------------------------------------

  async getAgentOfflineTimeout(): Promise<number> {
    const v = await this.read<{ seconds: number }>(SETTINGS_KEYS.agentOfflineTimeout);
    return v?.seconds ?? DEFAULT_OFFLINE_SECONDS;
  }

  async setAgentOfflineTimeout(seconds: number): Promise<void> {
    await this.write(SETTINGS_KEYS.agentOfflineTimeout, { seconds });
  }

  // --- Local login ----------------------------------------------------------

  /** Password and passkey logins are accepted unless an admin turned them off. */
  async getLocalLoginEnabled(): Promise<boolean> {
    const v = await this.read<{ enabled: boolean }>(SETTINGS_KEYS.localLogin);
    return v?.enabled ?? true;
  }

  /**
   * Turning local login off leaves SSO as the only way in, so it is refused
   * unless SSO can actually serve a login — otherwise the next request would
   * lock every admin out with no way back short of a database edit.
   */
  async setLocalLoginEnabled(enabled: boolean): Promise<void> {
    if (!enabled && !(await this.hasUsableSso())) {
      throw new BadRequestException(
        'Enable SSO with at least one fully configured provider before disabling local login',
      );
    }
    await this.write(SETTINGS_KEYS.localLogin, { enabled });
  }

  /** True when SSO is enabled and at least one provider is complete. */
  async hasUsableSso(): Promise<boolean> {
    const sso = await this.readSso();
    return sso.enabled && sso.providers.some(isProviderConfigured);
  }

  // --- SSO ------------------------------------------------------------------

  private async readSso(): Promise<StoredSso> {
    return normalizeStored(await this.read<unknown>(SETTINGS_KEYS.sso));
  }

  /** Decrypted SSO config for the SSO service (never sent to clients). */
  async getResolvedSso(): Promise<ResolvedSso> {
    const s = await this.readSso();
    return {
      enabled: s.enabled,
      providers: s.providers.map((p) => ({
        id: p.id,
        type: p.type,
        label: p.label,
        clientId: p.clientId,
        clientSecret: p.secret ? this.crypto.decrypt(p.secret) : '',
        issuerUrl: p.issuerUrl,
        tenantId: p.tenantId,
      })),
    };
  }

  async updateSso(update: SsoUpdate): Promise<void> {
    const cur = await this.readSso();
    const byId = new Map(cur.providers.map((p) => [p.id, p]));

    const providers: StoredProvider[] =
      update.providers === undefined
        ? cur.providers
        : update.providers.map((p) => {
            const existing = p.id ? byId.get(p.id) : undefined;
            return {
              id: existing?.id ?? randomUUID(),
              type: p.type,
              label: (p.label ?? existing?.label ?? '').trim(),
              clientId: (p.clientId ?? existing?.clientId ?? '').trim(),
              issuerUrl: (p.issuerUrl ?? existing?.issuerUrl ?? '').trim(),
              tenantId: (p.tenantId ?? existing?.tenantId ?? '').trim(),
              // A blank secret keeps the previously stored one (matched by id).
              secret: p.clientSecret
                ? this.crypto.encrypt(p.clientSecret)
                : (existing?.secret ?? null),
            };
          });

    const next: StoredSso = {
      enabled: update.enabled ?? cur.enabled,
      providers,
    };
    // Same lockout guard from the other side: SSO must stay usable while it is
    // the only way in.
    if (
      !(next.enabled && next.providers.some(isProviderConfigured)) &&
      !(await this.getLocalLoginEnabled())
    ) {
      throw new BadRequestException(
        'Local login is disabled, so SSO must keep at least one fully configured provider',
      );
    }
    await this.write(SETTINGS_KEYS.sso, next);
  }

  // --- Admin view -----------------------------------------------------------

  async getSystemView(): Promise<SystemSettingsView> {
    const [timeout, sso, localLogin] = await Promise.all([
      this.getAgentOfflineTimeout(),
      this.readSso(),
      this.getLocalLoginEnabled(),
    ]);
    const base = loadConfig().publicBaseUrl.replace(/\/$/, '');
    return {
      agentOfflineTimeoutSeconds: timeout,
      localLoginEnabled: localLogin,
      sso: {
        enabled: sso.enabled,
        providers: sso.providers.map((p) => ({
          id: p.id,
          type: p.type,
          label: p.label,
          clientId: p.clientId,
          issuerUrl: p.issuerUrl,
          tenantId: p.tenantId,
          clientSecretSet: !!p.secret,
        })),
      },
      ssoRedirectUri: `${base}/api/auth/callback`,
    };
  }
}

/**
 * Coerces a stored value into the current SSO shape, tolerating both the new
 * `{ enabled, providers[] }` form and the legacy fixed `{ oidc, entra }` form.
 */
function normalizeStored(raw: unknown): StoredSso {
  if (!raw || typeof raw !== 'object') return EMPTY_SSO;
  const obj = raw as Record<string, unknown>;

  if (Array.isArray(obj.providers)) {
    return {
      enabled: !!obj.enabled,
      providers: (obj.providers as unknown[])
        .map(coerceProvider)
        .filter((p): p is StoredProvider => p !== null),
    };
  }

  // Legacy migration: fixed oidc/entra blocks → provider list with stable ids.
  const providers: StoredProvider[] = [];
  const legacy = (key: 'oidc' | 'entra', type: SsoProviderType) => {
    const b = obj[key] as Record<string, unknown> | undefined;
    if (!b) return;
    providers.push({
      id: type,
      type,
      label: '',
      clientId: String(b.clientId ?? ''),
      issuerUrl: String(b.issuerUrl ?? ''),
      tenantId: String(b.tenantId ?? ''),
      secret: (b.secret as EncryptedPayload | null) ?? null,
    });
  };
  legacy('oidc', 'oidc');
  legacy('entra', 'entra');
  const anyEnabled =
    !!(obj.oidc as { enabled?: boolean } | undefined)?.enabled ||
    !!(obj.entra as { enabled?: boolean } | undefined)?.enabled;
  return { enabled: anyEnabled, providers };
}

/**
 * A provider can serve a login once it has credentials and the field its kind
 * needs to resolve an issuer.
 */
function isProviderConfigured(p: StoredProvider): boolean {
  if (!p.clientId || !p.secret) return false;
  if (p.type === 'oidc') return !!p.issuerUrl;
  if (p.type === 'entra') return !!p.tenantId;
  return true;
}

function coerceProvider(raw: unknown): StoredProvider | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!SSO_PROVIDER_TYPES.includes(p.type as SsoProviderType)) return null;
  return {
    id: typeof p.id === 'string' && p.id ? p.id : randomUUID(),
    type: p.type as SsoProviderType,
    label: String(p.label ?? ''),
    clientId: String(p.clientId ?? ''),
    issuerUrl: String(p.issuerUrl ?? ''),
    tenantId: String(p.tenantId ?? ''),
    secret: (p.secret as EncryptedPayload | null) ?? null,
  };
}
