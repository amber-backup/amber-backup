import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval, Timeout } from '@nestjs/schedule';
import * as net from 'node:net';
import { Db, KYSELY } from '../database/database.module';
import { SecretsService } from '../crypto/secrets.service';
import { Target, TargetStatus } from '../database/database.types';

/**
 * Reachability checks for targets (backend connections). A target carries no
 * repository password, so this is a network-level probe of the connection's
 * endpoint — TCP for SFTP, an HTTP request for the HTTP-based backends. Any
 * HTTP response (including 401/403) proves the endpoint is reachable;
 * credentials are deliberately not validated here.
 *
 * Backends without a probeable endpoint (rclone) stay 'unknown'.
 */

const CHECK_TIMEOUT_MS = 10_000;
const CHECK_INTERVAL_MS = 5 * 60_000;

export interface CheckOutcome {
  status: TargetStatus;
  error: string | null;
}

export type ProbeSpec =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'http'; url: string }
  | { kind: 'none' };

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

/** Prepends https:// when the value has no scheme (endpoints, REST URLs). */
function ensureScheme(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/**
 * Derives what to probe for a backend from its connection config/credentials.
 * Pure so the per-backend mapping is unit-testable without network access.
 */
export function probeSpecFor(
  backendType: string,
  config: Record<string, unknown>,
  credentials: Record<string, string>,
): ProbeSpec {
  switch (backendType) {
    case 'sftp': {
      const host = str(config.host);
      if (!host) return { kind: 'none' };
      const port = Number(config.port) || 22;
      return { kind: 'tcp', host, port };
    }
    case 'rest': {
      const url = str(config.url);
      return url ? { kind: 'http', url: ensureScheme(url) } : { kind: 'none' };
    }
    case 's3': {
      const endpoint = str(config.endpoint);
      return endpoint
        ? { kind: 'http', url: ensureScheme(endpoint) }
        : { kind: 'none' };
    }
    case 'b2':
      return { kind: 'http', url: 'https://api.backblazeb2.com' };
    case 'azure': {
      const account = str(config.accountName);
      return account
        ? { kind: 'http', url: `https://${account}.blob.core.windows.net` }
        : { kind: 'none' };
    }
    case 'gs':
      return { kind: 'http', url: 'https://storage.googleapis.com' };
    case 'swift': {
      const authUrl = str(credentials.authUrl);
      return authUrl
        ? { kind: 'http', url: ensureScheme(authUrl) }
        : { kind: 'none' };
    }
    default:
      // rclone and future backends without a known endpoint.
      return { kind: 'none' };
  }
}

/** Compact, non-sensitive failure reason (error code over free-form message). */
function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return cause.code;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
    return cause?.message ?? err.message;
  }
  return String(err);
}

function probeTcp(host: string, port: number): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (status: TargetStatus, error: string | null) => {
      socket.destroy();
      resolve({ status, error });
    };
    socket.setTimeout(CHECK_TIMEOUT_MS, () => done('offline', 'timeout'));
    socket.once('connect', () => done('online', null));
    socket.once('error', (err) =>
      done('offline', (err as NodeJS.ErrnoException).code ?? err.message),
    );
  });
}

async function probeHttp(url: string): Promise<CheckOutcome> {
  try {
    // Any HTTP response — auth errors included — proves reachability.
    await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    return { status: 'online', error: null };
  } catch (err) {
    return { status: 'offline', error: errMessage(err) };
  }
}

@Injectable()
export class TargetHealthService {
  private readonly logger = new Logger(TargetHealthService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly secrets: SecretsService,
  ) {}

  /** First sweep shortly after boot so the UI isn't 'unknown' for 5 minutes. */
  @Timeout(5_000)
  async initialSweep(): Promise<void> {
    await this.sweep();
  }

  @Interval(CHECK_INTERVAL_MS)
  async sweep(): Promise<void> {
    const targets = await this.db.selectFrom('targets').selectAll().execute();
    await Promise.all(
      targets.map((t) =>
        this.checkAndStore(t).catch((e) =>
          this.logger.warn(`Health check for target ${t.id} failed: ${e}`),
        ),
      ),
    );
  }

  /** Probes a single target now and persists the outcome. */
  async refresh(id: string): Promise<CheckOutcome & { last_check_at: Date }> {
    const t = await this.db
      .selectFrom('targets')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!t) return { status: 'unknown', error: null, last_check_at: new Date() };
    const outcome = await this.checkAndStore(t);
    return { ...outcome, last_check_at: new Date() };
  }

  private async checkAndStore(t: Target): Promise<CheckOutcome> {
    const outcome = await this.check(t);
    // Deliberately not touching updated_at — that tracks config edits.
    await this.db
      .updateTable('targets')
      .set({
        status: outcome.status,
        last_check_at: new Date(),
        last_check_error: outcome.error,
      })
      .where('id', '=', t.id)
      .execute();
    return outcome;
  }

  private async check(t: Target): Promise<CheckOutcome> {
    const config =
      typeof t.config === 'string'
        ? (JSON.parse(t.config) as Record<string, unknown>)
        : (t.config ?? {});
    // Only swift keeps its endpoint (authUrl) in the credential secret.
    let credentials: Record<string, string> = {};
    if (t.backend_type === 'swift' && t.credential_secret_id) {
      credentials = JSON.parse(
        await this.secrets.reveal(t.credential_secret_id),
      ) as Record<string, string>;
    }
    const spec = probeSpecFor(t.backend_type, config, credentials);
    if (spec.kind === 'none') return { status: 'unknown', error: null };
    return spec.kind === 'tcp'
      ? probeTcp(spec.host, spec.port)
      : probeHttp(spec.url);
  }
}
