import { AppConfig, validateConfig } from './configuration';
import { TEST_MASTER_KEY } from '../testing/db-mock';

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
