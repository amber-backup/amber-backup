import { Logger } from '@nestjs/common';
import { Pool, PoolConfig } from 'pg';

export interface PoolOptions {
  connectionString: string;
  max?: number;
  /** Server-side statement_timeout in ms; <= 0 / undefined = none. */
  statementTimeoutMs?: number;
  /** How long acquiring a connection may take in ms (default 10 s). */
  connectionTimeoutMs?: number;
  /** Logger name for pool errors. */
  name?: string;
}

/** Builds the pg pool configuration (exported for tests). */
export function poolConfig(opts: PoolOptions): PoolConfig {
  const config: PoolConfig = {
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    // Without this a hung/unreachable DB makes every query wait forever.
    connectionTimeoutMillis:
      opts.connectionTimeoutMs && opts.connectionTimeoutMs > 0
        ? opts.connectionTimeoutMs
        : 10_000,
    idleTimeoutMillis: 30_000,
    // Detect half-open TCP connections (NAT/firewall drops, DB host gone).
    keepAlive: true,
  };
  if (opts.statementTimeoutMs && opts.statementTimeoutMs > 0) {
    config.options = `-c statement_timeout=${Math.floor(opts.statementTimeoutMs)}`;
  }
  return config;
}

/**
 * Creates a pg pool that survives a database restart. An idle client whose
 * connection the server terminates (restart, failover, pg_terminate_backend)
 * makes pg-pool emit 'error' on the pool; without a listener that is an
 * uncaught exception and the whole process dies. The broken client is already
 * discarded by the pool, so logging is all that is needed — the next query
 * opens a fresh connection.
 */
export function createPool(opts: PoolOptions): Pool {
  const pool = new Pool(poolConfig(opts));
  const logger = new Logger(opts.name ?? 'Database');
  pool.on('error', (err: Error) => {
    logger.warn(`Idle database connection failed: ${err.message}`);
  });
  return pool;
}

/** Errors that mean "the database is not reachable (yet)", worth retrying. */
export function isTransientConnectError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      // Postgres: cannot_connect_now (starting up / shutting down), admin
      // shutdown, crash shutdown, too many connections.
      '57P03',
      '57P01',
      '57P02',
      '53300',
    ].includes(code)
  ) {
    return true;
  }
  const message = typeof e?.message === 'string' ? e.message : '';
  return /timeout exceeded when trying to connect|Connection terminated/i.test(
    message,
  );
}

/**
 * Waits until the database accepts connections, retrying transient errors with
 * exponential backoff (1 s, 2 s, 4 s … capped at 15 s) for up to `maxWaitMs`.
 * Lets the server start while a freshly started Postgres container is still
 * coming up instead of crash-looping. Non-transient errors (bad password,
 * unknown database) are thrown immediately.
 */
export async function waitForDatabase(
  pool: Pool,
  opts: {
    maxWaitMs?: number;
    log?: (message: string) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<void> {
  const maxWaitMs = opts.maxWaitMs ?? 120_000;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const started = now();
  let delay = 1000;
  for (;;) {
    try {
      const client = await pool.connect();
      client.release();
      return;
    } catch (err) {
      if (!isTransientConnectError(err) || now() - started + delay > maxWaitMs) {
        throw err;
      }
      opts.log?.(
        `Database not reachable (${(err as Error).message}); retrying in ${Math.round(delay / 1000)} s`,
      );
      await sleep(delay);
      delay = Math.min(delay * 2, 15_000);
    }
  }
}
