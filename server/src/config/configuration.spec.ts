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
});
