import { AppConfig, loadConfig, validateConfig } from './configuration';
import { TEST_MASTER_KEY } from '../testing/db-mock';

describe('loadConfig (swaggerEnabled)', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  function load(env: Record<string, string | undefined>): AppConfig {
    process.env = { ...original, NODE_ENV: undefined, SWAGGER_ENABLED: undefined };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return loadConfig();
  }

  it('defaults to enabled outside production', () => {
    expect(load({ NODE_ENV: 'development' }).swaggerEnabled).toBe(true);
  });

  it('defaults to disabled in production', () => {
    expect(load({ NODE_ENV: 'production' }).swaggerEnabled).toBe(false);
  });

  it('can be enabled in production via SWAGGER_ENABLED', () => {
    expect(
      load({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }).swaggerEnabled,
    ).toBe(true);
  });

  it('can be disabled in development via SWAGGER_ENABLED', () => {
    expect(
      load({ NODE_ENV: 'development', SWAGGER_ENABLED: 'false' }).swaggerEnabled,
    ).toBe(false);
  });
});

describe('validateConfig (crypto material validation)', () => {
  function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
      masterEncryptionKey: TEST_MASTER_KEY,
      jwtSecret: 'a-secret',
      databaseUrl: 'postgres://amber:amber@localhost:5432/amber',
      adminAllowedIps: [],
      ...overrides,
    } as AppConfig;
  }

  it('accepts a 32-byte base64 master key with the other required secrets', () => {
    expect(() => validateConfig(baseConfig())).not.toThrow();
  });

  it('rejects a missing master key', () => {
    expect(() =>
      validateConfig(baseConfig({ masterEncryptionKey: '' })),
    ).toThrow(/MASTER_ENCRYPTION_KEY is required/);
  });

  it('rejects a master key that does not decode to exactly 32 bytes', () => {
    const shortKey = Buffer.alloc(16, 1).toString('base64');
    expect(() =>
      validateConfig(baseConfig({ masterEncryptionKey: shortKey })),
    ).toThrow(/32 bytes/);

    const longKey = Buffer.alloc(48, 1).toString('base64');
    expect(() =>
      validateConfig(baseConfig({ masterEncryptionKey: longKey })),
    ).toThrow(/32 bytes/);
  });

  it('rejects a missing JWT secret', () => {
    expect(() => validateConfig(baseConfig({ jwtSecret: '' }))).toThrow(
      /JWT_SECRET is required/,
    );
  });

  it('aggregates multiple errors into one message', () => {
    expect(() =>
      validateConfig(
        baseConfig({ masterEncryptionKey: '', jwtSecret: '', databaseUrl: '' }),
      ),
    ).toThrow(/MASTER_ENCRYPTION_KEY[\s\S]*JWT_SECRET[\s\S]*DATABASE_URL/);
  });

  it('rejects ADMIN_ALLOWED_IPS entries that are not an address or range', () => {
    expect(() =>
      validateConfig(baseConfig({ adminAllowedIps: ['10.0.0.0/8', 'intranet'] })),
    ).toThrow(/ADMIN_ALLOWED_IPS .*intranet/);
  });
});

describe('loadConfig (run lifecycle timeouts)', () => {
  const keys = [
    'RESTORE_QUEUE_TIMEOUT_SECONDS',
    'AGENT_TASK_HEARTBEAT_TIMEOUT_SECONDS',
    'AGENT_TASK_LEGACY_TIMEOUT_SECONDS',
  ];
  afterEach(() => {
    for (const k of keys) delete process.env[k];
  });

  it('defaults to 1 h for queued restores, 10 min for task leases and 24 h for older agents', () => {
    for (const k of keys) delete process.env[k];
    const config = loadConfig();
    expect(config.restoreQueueTimeoutSeconds).toBe(3600);
    expect(config.agentTaskHeartbeatTimeoutSeconds).toBe(600);
    expect(config.agentTaskLegacyTimeoutSeconds).toBe(86_400);
  });

  it('reads them from the environment', () => {
    process.env.RESTORE_QUEUE_TIMEOUT_SECONDS = '0';
    process.env.AGENT_TASK_HEARTBEAT_TIMEOUT_SECONDS = '1200';
    process.env.AGENT_TASK_LEGACY_TIMEOUT_SECONDS = '7200';
    const config = loadConfig();
    expect(config.restoreQueueTimeoutSeconds).toBe(0);
    expect(config.agentTaskHeartbeatTimeoutSeconds).toBe(1200);
    expect(config.agentTaskLegacyTimeoutSeconds).toBe(7200);
  });
});
