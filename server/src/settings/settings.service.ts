import { Inject, Injectable } from '@nestjs/common';
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
} as const;

const DEFAULT_OFFLINE_SECONDS = 120;

interface StoredOidc {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  secret: EncryptedPayload | null;
}
interface StoredEntra {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  secret: EncryptedPayload | null;
}
interface StoredSso {
  oidc: StoredOidc;
  entra: StoredEntra;
}

/** Decrypted SSO config for internal use by the SSO service. */
export interface ResolvedSso {
  oidc: { enabled: boolean; issuerUrl: string; clientId: string; clientSecret: string };
  entra: { enabled: boolean; tenantId: string; clientId: string; clientSecret: string };
}

/** Admin-facing SSO update; a blank/omitted clientSecret leaves it unchanged. */
export interface SsoUpdate {
  oidc?: {
    enabled?: boolean;
    issuerUrl?: string;
    clientId?: string;
    clientSecret?: string;
  };
  entra?: {
    enabled?: boolean;
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
  };
}

/** Admin-facing view (secrets never leave the server — only a "set" flag). */
export interface SystemSettingsView {
  agentOfflineTimeoutSeconds: number;
  sso: {
    oidc: { enabled: boolean; issuerUrl: string; clientId: string; clientSecretSet: boolean };
    entra: { enabled: boolean; tenantId: string; clientId: string; clientSecretSet: boolean };
  };
  /** Redirect URI to register with the identity provider. */
  ssoRedirectUri: string;
}

const EMPTY_SSO: StoredSso = {
  oidc: { enabled: false, issuerUrl: '', clientId: '', secret: null },
  entra: { enabled: false, tenantId: '', clientId: '', secret: null },
};

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

  // --- SSO ------------------------------------------------------------------

  private async readSso(): Promise<StoredSso> {
    return (await this.read<StoredSso>(SETTINGS_KEYS.sso)) ?? EMPTY_SSO;
  }

  /** Decrypted SSO config for the SSO service (never sent to clients). */
  async getResolvedSso(): Promise<ResolvedSso> {
    const s = await this.readSso();
    return {
      oidc: {
        enabled: s.oidc.enabled,
        issuerUrl: s.oidc.issuerUrl,
        clientId: s.oidc.clientId,
        clientSecret: s.oidc.secret ? this.crypto.decrypt(s.oidc.secret) : '',
      },
      entra: {
        enabled: s.entra.enabled,
        tenantId: s.entra.tenantId,
        clientId: s.entra.clientId,
        clientSecret: s.entra.secret ? this.crypto.decrypt(s.entra.secret) : '',
      },
    };
  }

  async updateSso(update: SsoUpdate): Promise<void> {
    const cur = await this.readSso();
    const next: StoredSso = {
      oidc: {
        enabled: update.oidc?.enabled ?? cur.oidc.enabled,
        issuerUrl: update.oidc?.issuerUrl ?? cur.oidc.issuerUrl,
        clientId: update.oidc?.clientId ?? cur.oidc.clientId,
        secret: update.oidc?.clientSecret
          ? this.crypto.encrypt(update.oidc.clientSecret)
          : cur.oidc.secret,
      },
      entra: {
        enabled: update.entra?.enabled ?? cur.entra.enabled,
        tenantId: update.entra?.tenantId ?? cur.entra.tenantId,
        clientId: update.entra?.clientId ?? cur.entra.clientId,
        secret: update.entra?.clientSecret
          ? this.crypto.encrypt(update.entra.clientSecret)
          : cur.entra.secret,
      },
    };
    await this.write(SETTINGS_KEYS.sso, next);
  }

  // --- Admin view -----------------------------------------------------------

  async getSystemView(): Promise<SystemSettingsView> {
    const [timeout, sso] = await Promise.all([
      this.getAgentOfflineTimeout(),
      this.readSso(),
    ]);
    const base = loadConfig().publicBaseUrl.replace(/\/$/, '');
    return {
      agentOfflineTimeoutSeconds: timeout,
      sso: {
        oidc: {
          enabled: sso.oidc.enabled,
          issuerUrl: sso.oidc.issuerUrl,
          clientId: sso.oidc.clientId,
          clientSecretSet: !!sso.oidc.secret,
        },
        entra: {
          enabled: sso.entra.enabled,
          tenantId: sso.entra.tenantId,
          clientId: sso.entra.clientId,
          clientSecretSet: !!sso.entra.secret,
        },
      },
      ssoRedirectUri: `${base}/api/auth/callback`,
    };
  }
}
