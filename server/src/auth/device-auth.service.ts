import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomInt } from 'crypto';
import { Db, KYSELY } from '../database/database.module';
import { CryptoService } from '../crypto/crypto.service';
import { AuditService } from '../audit/audit.service';
import { RequestUser } from '../common/auth/request-user';
import { ApiKeysService } from './api-keys.service';
import {
  DeviceApproveDto,
  DeviceCodeResponseDto,
  DeviceRequestInfoDto,
  DeviceTokenResponseDto,
} from './dto/device-auth.dto';

/** How long a pairing request stays valid. */
export const DEVICE_CODE_TTL_SECONDS = 600;
/** Minimum seconds between two token polls of the same device. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
/** Consonants only: no look-alikes (0/O, 1/I) and no accidental words. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LENGTH = 8;
const USER_CODE_RE = new RegExp(`^[${USER_CODE_ALPHABET}]{${USER_CODE_LENGTH}}$`);
/** Finished requests are kept this long for traceability, then purged. */
const RETENTION_MS = 24 * 3600_000;
const MAX_USER_AGENT = 256;

/** Context of the unauthenticated request that started or polls a pairing. */
export interface DeviceRequestContext {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Device authorization for the CLI, after RFC 8628: the CLI obtains a secret
 * device code and a short user code, a signed-in user confirms the user code in
 * the web UI, and the CLI's poll then receives a newly minted API key.
 *
 * Security properties:
 * - Both codes are stored as SHA-256 hashes only; the device code carries 256
 *   bits of entropy and never leaves the CLI and the token endpoint.
 * - The API key is minted when the CLI claims it, so no plaintext credential is
 *   ever stored; claiming is an atomic status transition, so a device code
 *   yields at most one key.
 * - Requests expire after {@link DEVICE_CODE_TTL_SECONDS}; approval is limited to
 *   interactive sessions and the approver picks the key's access and lifetime.
 */
@Injectable()
export class DeviceAuthService {
  private readonly logger = new Logger(DeviceAuthService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly apiKeys: ApiKeysService,
    private readonly audit: AuditService,
  ) {}

  /** Starts a pairing for the named device. */
  async requestCode(
    clientName: string,
    ctx: DeviceRequestContext,
  ): Promise<DeviceCodeResponseDto> {
    const deviceCode = this.crypto.generateToken(32);
    const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000);

    // A user-code collision with a stored row is astronomically unlikely but
    // would violate the unique index; draw a fresh code instead of failing.
    for (let attempt = 0; ; attempt++) {
      const userCode = generateUserCode();
      try {
        await this.db
          .insertInto('device_authorizations')
          .values({
            device_code_hash: this.crypto.hashToken(deviceCode),
            user_code_hash: this.crypto.hashToken(userCode),
            client_name: clientName.trim(),
            request_ip: ctx.ip,
            request_user_agent: ctx.userAgent?.slice(0, MAX_USER_AGENT) ?? null,
            expires_at: expiresAt,
          })
          .execute();
      } catch (err) {
        if (attempt < 3 && (err as { code?: string }).code === '23505') continue;
        throw err;
      }
      const display = formatUserCode(userCode);
      return {
        deviceCode,
        userCode: display,
        verificationPath: `/#/device?code=${display}`,
        expiresIn: DEVICE_CODE_TTL_SECONDS,
        interval: DEVICE_POLL_INTERVAL_SECONDS,
      };
    }
  }

  /**
   * Polled by the CLI. Returns the pairing's state and, exactly once after
   * approval, the issued API key.
   */
  async exchange(
    deviceCode: string,
    ctx: DeviceRequestContext,
  ): Promise<DeviceTokenResponseDto> {
    const now = new Date();
    const row = await this.db
      .selectFrom('device_authorizations')
      .select(['id', 'status', 'expires_at', 'last_polled_at'])
      .where('device_code_hash', '=', this.crypto.hashToken(deviceCode))
      .executeTakeFirst();

    // A consumed code reads as expired: it must not be usable twice.
    if (!row || row.status === 'consumed' || new Date(row.expires_at) <= now) {
      return { status: 'expired' };
    }
    if (row.status === 'denied') return { status: 'denied' };

    if (row.status === 'pending') {
      const tooFast =
        row.last_polled_at != null &&
        now.getTime() - new Date(row.last_polled_at).getTime() <
          (DEVICE_POLL_INTERVAL_SECONDS - 1) * 1000;
      await this.db
        .updateTable('device_authorizations')
        .set({ last_polled_at: now })
        .where('id', '=', row.id)
        .execute();
      return { status: tooFast ? 'slow_down' : 'pending' };
    }

    return this.claim(row.id, now, ctx);
  }

  /** Atomically consumes an approved pairing and mints its API key. */
  private async claim(
    id: string,
    now: Date,
    ctx: DeviceRequestContext,
  ): Promise<DeviceTokenResponseDto> {
    const issued = await this.db.transaction().execute(async (trx) => {
      const claimed = await trx
        .updateTable('device_authorizations')
        .set({ status: 'consumed', last_polled_at: now })
        .where('id', '=', id)
        .where('status', '=', 'approved')
        .where('expires_at', '>', now)
        .returning(['user_id', 'client_name', 'access', 'key_expires_in_days'])
        .executeTakeFirst();
      if (!claimed?.user_id || !claimed.access) return null;

      const user = await trx
        .selectFrom('users')
        .select(['id', 'email', 'is_admin', 'disabled'])
        .where('id', '=', claimed.user_id)
        .executeTakeFirst();
      if (!user || user.disabled) return null;

      const key = await this.apiKeys.create(
        user.id,
        {
          name: `CLI: ${claimed.client_name}`,
          scopes: { actions: claimed.access === 'read' ? ['read'] : ['*'] },
          expiresInDays: claimed.key_expires_in_days ?? undefined,
        },
        trx,
      );
      await trx
        .updateTable('device_authorizations')
        .set({ api_key_id: key.id })
        .where('id', '=', id)
        .execute();
      return { user, key, access: claimed.access, clientName: claimed.client_name };
    });

    if (!issued) return { status: 'expired' };

    void this.audit.record({
      actorId: issued.user.id,
      actorEmail: issued.user.email,
      actorType: 'apikey',
      actorIsAdmin: issued.user.is_admin,
      action: 'CLI device login',
      method: 'POST',
      path: '/api/auth/device/token',
      resourceType: 'auth',
      resourceId: issued.key.id,
      statusCode: 200,
      outcome: 'success',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      details: {
        clientName: issued.clientName,
        access: issued.access,
        keyPrefix: issued.key.prefix,
      },
    });

    return {
      status: 'approved',
      apiKey: issued.key.key,
      email: issued.user.email,
      access: issued.access,
      expiresAt: issued.key.expiresAt,
    };
  }

  /** Details of a pending pairing, for the approval screen. */
  async lookup(userCode: string): Promise<DeviceRequestInfoDto> {
    const row = await this.db
      .selectFrom('device_authorizations')
      .select([
        'client_name',
        'request_ip',
        'request_user_agent',
        'created_at',
        'expires_at',
      ])
      .where('user_code_hash', '=', this.hashUserCode(userCode))
      .where('status', '=', 'pending')
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Unknown or expired code');
    return {
      clientName: row.client_name,
      requestIp: row.request_ip,
      requestUserAgent: row.request_user_agent,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  /** Approves a pending pairing on behalf of the signed-in user. */
  async approve(user: RequestUser, dto: DeviceApproveDto): Promise<void> {
    const res = await this.db
      .updateTable('device_authorizations')
      .set({
        status: 'approved',
        user_id: user.id,
        access: dto.access,
        key_expires_in_days: dto.expiresInDays ?? null,
        decided_at: new Date(),
      })
      .where('user_code_hash', '=', this.hashUserCode(dto.userCode))
      .where('status', '=', 'pending')
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
    if (!res.numUpdatedRows) throw new NotFoundException('Unknown or expired code');
  }

  /** Rejects a pending pairing; the CLI's next poll reports the denial. */
  async deny(user: RequestUser, userCode: string): Promise<void> {
    const res = await this.db
      .updateTable('device_authorizations')
      .set({ status: 'denied', user_id: user.id, decided_at: new Date() })
      .where('user_code_hash', '=', this.hashUserCode(userCode))
      .where('status', '=', 'pending')
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
    if (!res.numUpdatedRows) throw new NotFoundException('Unknown or expired code');
  }

  /** Revokes the API key authenticating the request (`ambb logout`). */
  async revokeCurrentKey(user: RequestUser): Promise<void> {
    if (user.authVia !== 'apikey' || !user.apiKeyId) {
      throw new BadRequestException('Only an API key can revoke itself');
    }
    await this.apiKeys.remove(user.id, user.apiKeyId);
  }

  @Interval(3600_000)
  async purgeExpired(): Promise<void> {
    try {
      await this.db
        .deleteFrom('device_authorizations')
        .where('expires_at', '<', new Date(Date.now() - RETENTION_MS))
        .execute();
    } catch (err) {
      this.logger.warn(`Purging device authorizations failed: ${String(err)}`);
    }
  }

  /** Hash of a user-entered code; malformed input can never match a row. */
  private hashUserCode(input: string): string {
    const normalized = normalizeUserCode(input);
    if (!normalized) throw new NotFoundException('Unknown or expired code');
    return this.crypto.hashToken(normalized);
  }
}

export function generateUserCode(): string {
  let code = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return code;
}

/** `BCDFGHJK` → `BCDF-GHJK`. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Canonical form of user input (case, dashes and spaces ignored), or null. */
export function normalizeUserCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return USER_CODE_RE.test(code) ? code : null;
}
