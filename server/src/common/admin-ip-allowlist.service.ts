import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Db, KYSELY } from '../database/database.module';
import { loadConfig } from '../config/configuration';
import { ipAllowed, isValidAllowlistEntry, normalizeIp } from './ip-allowlist';

const SETTINGS_KEY = 'admin_ip_allowlist';

/** How long the stored list is reused before it is read again. */
const CACHE_MS = 5_000;

/** Admin-facing view of the allowlist. */
export interface AdminIpAllowlistView {
  /** Entries maintained in the UI. */
  entries: string[];
  /** Entries fixed by ADMIN_ALLOWED_IPS; not editable at runtime. */
  envEntries: string[];
  /** The caller's address as the server sees it. */
  currentIp: string | null;
}

/**
 * Restricts administrators to known addresses. The effective allowlist is the
 * union of ADMIN_ALLOWED_IPS and the list admins maintain in the UI; while it
 * is empty, administrators may connect from anywhere.
 *
 * It is enforced for every authenticated request of an administrator (session
 * or API key) and before any login hands an administrator a session.
 */
@Injectable()
export class AdminIpAllowlistService {
  private readonly logger = new Logger(AdminIpAllowlistService.name);
  private cache: { entries: string[]; at: number } | null = null;

  constructor(@Inject(KYSELY) private readonly db: Db) {}

  private envEntries(): string[] {
    return loadConfig().adminAllowedIps;
  }

  private async storedEntries(): Promise<string[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) {
      return this.cache.entries;
    }
    const row = await this.db
      .selectFrom('app_settings')
      .select('value')
      .where('key', '=', SETTINGS_KEY)
      .executeTakeFirst();
    const raw = row?.value;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const entries = Array.isArray((parsed as { entries?: unknown })?.entries)
      ? ((parsed as { entries: unknown[] }).entries.filter(
          (e): e is string => typeof e === 'string',
        ))
      : [];
    this.cache = { entries, at: Date.now() };
    return entries;
  }

  private async effective(): Promise<string[]> {
    return [...this.envEntries(), ...(await this.storedEntries())];
  }

  /** True if an administrator may act from `ip`. */
  async isAllowed(ip: string | null | undefined): Promise<boolean> {
    return ipAllowed(await this.effective(), ip ?? undefined);
  }

  /** Throws 403 unless an administrator may act from `ip`. */
  async assertAllowed(ip: string | null | undefined, email: string): Promise<void> {
    if (await this.isAllowed(ip)) return;
    this.logger.warn(
      `Administrator ${email} rejected: ${ip ? normalizeIp(ip) : 'unknown address'} is not in the admin IP allowlist`,
    );
    throw new ForbiddenException(
      'Administrator access is not allowed from this address',
    );
  }

  async view(callerIp: string | null | undefined): Promise<AdminIpAllowlistView> {
    return {
      entries: await this.storedEntries(),
      envEntries: this.envEntries(),
      currentIp: callerIp ? normalizeIp(callerIp) : null,
    };
  }

  /**
   * Replaces the UI-maintained entries. Refused when the result would no
   * longer admit the caller — saving must never lock out the admin doing it.
   */
  async update(
    entries: string[],
    callerIp: string | null | undefined,
  ): Promise<AdminIpAllowlistView> {
    const next = [...new Set(entries.map((e) => e.trim()).filter(Boolean))];
    const invalid = next.filter((e) => !isValidAllowlistEntry(e));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Not an IP address or CIDR range: ${invalid.join(', ')}`,
      );
    }
    if (!ipAllowed([...this.envEntries(), ...next], callerIp ?? undefined)) {
      throw new BadRequestException(
        `The allowlist must include your current address (${callerIp ? normalizeIp(callerIp) : 'unknown'}), or you would lock yourself out`,
      );
    }
    const value = JSON.stringify({ entries: next });
    await this.db
      .insertInto('app_settings')
      .values({ key: SETTINGS_KEY, value, updated_at: new Date() })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({ value, updated_at: new Date() }),
      )
      .execute();
    this.cache = { entries: next, at: Date.now() };
    return this.view(callerIp);
  }
}
