import { Pool } from 'pg';
import {
  createPool,
  isTransientConnectError,
  poolConfig,
  waitForDatabase,
} from './pool';

describe('database pool', () => {
  it('sets connection/idle timeouts, keepAlive and the statement timeout', () => {
    const config = poolConfig({
      connectionString: 'postgres://x',
      statementTimeoutMs: 60_000,
      connectionTimeoutMs: 5000,
    });
    expect(config).toMatchObject({
      connectionString: 'postgres://x',
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
      options: '-c statement_timeout=60000',
    });
  });

  it('omits the statement timeout when disabled', () => {
    const config = poolConfig({
      connectionString: 'postgres://x',
      statementTimeoutMs: 0,
    });
    expect(config.options).toBeUndefined();
    expect(config.connectionTimeoutMillis).toBe(10_000);
  });

  it('does not crash the process when an idle client errors', async () => {
    const pool = createPool({ connectionString: 'postgres://x' });
    expect(pool.listenerCount('error')).toBe(1);
    // An 'error' event without a listener would throw synchronously.
    expect(() =>
      pool.emit('error', Object.assign(new Error('terminating connection'), { code: '57P01' })),
    ).not.toThrow();
    await pool.end();
  });

  it('classifies transient connect errors', () => {
    expect(isTransientConnectError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isTransientConnectError({ code: '57P03' })).toBe(true);
    expect(
      isTransientConnectError(new Error('timeout exceeded when trying to connect')),
    ).toBe(true);
    // Wrong password / unknown database are not worth retrying.
    expect(isTransientConnectError({ code: '28P01' })).toBe(false);
    expect(isTransientConnectError({ code: '3D000' })).toBe(false);
  });

  describe('waitForDatabase', () => {
    const fakePool = (failures: unknown[]) => {
      const release = jest.fn();
      const connect = jest.fn(async () => {
        const next = failures.shift();
        if (next) throw next;
        return { release };
      });
      return { pool: { connect } as unknown as Pool, connect, release };
    };

    it('retries transient errors with backoff until the DB is up', async () => {
      const { pool, connect, release } = fakePool([
        Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('starting'), { code: '57P03' }),
      ]);
      const sleeps: number[] = [];
      await waitForDatabase(pool, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      expect(connect).toHaveBeenCalledTimes(3);
      expect(release).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([1000, 2000]);
    });

    it('throws non-transient errors immediately', async () => {
      const err = Object.assign(new Error('password authentication failed'), {
        code: '28P01',
      });
      const { pool, connect } = fakePool([err]);
      await expect(
        waitForDatabase(pool, { sleep: async () => undefined }),
      ).rejects.toBe(err);
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it('gives up after maxWaitMs', async () => {
      const refused = () =>
        Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      const { pool } = fakePool([refused(), refused(), refused(), refused()]);
      let t = 0;
      await expect(
        waitForDatabase(pool, {
          maxWaitMs: 3500,
          now: () => t,
          sleep: async (ms) => {
            t += ms;
          },
        }),
      ).rejects.toThrow('refused');
    });
  });
});
