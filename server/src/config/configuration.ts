// Load .env into process.env as early as possible (dev/local). In production
// the environment is provided directly and the (absent) file is simply ignored.
import 'dotenv/config';

/**
 * Central typed configuration, loaded from environment variables.
 * Fail-fast validation happens in `validateConfig`.
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  publicBaseUrl: string;
  databaseUrl: string;
  masterEncryptionKey: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  /** Whether session/SSO cookies get the Secure flag (breaks login over HTTP). */
  cookieSecure: boolean;
  resticBinary: string;
  resticCacheDir: string;
  restoreTmpDir: string;
  /** Directory holding the compiled agent binaries served to hosts. */
  agentBinaryDir: string;
  /** Days to keep audit log entries; <= 0 disables purging (keep forever). */
  auditRetentionDays: number;
  bootstrapAdminEmail: string;
  bootstrapAdminPassword: string;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): AppConfig {
  const env = process.env;
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: int(env.PORT, 3000),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    databaseUrl:
      env.DATABASE_URL ?? 'postgres://amber:amber@localhost:5432/amber',
    masterEncryptionKey: env.MASTER_ENCRYPTION_KEY ?? '',
    jwtSecret: env.JWT_SECRET ?? '',
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? '7d',
    // Default: secure cookies only when the public URL is https. Explicit
    // COOKIE_SECURE overrides. Prevents dropped cookies on plain-HTTP setups.
    cookieSecure: bool(
      env.COOKIE_SECURE,
      (env.PUBLIC_BASE_URL ?? '').startsWith('https://'),
    ),
    resticBinary: env.RESTIC_BINARY ?? 'restic',
    resticCacheDir: env.RESTIC_CACHE_DIR ?? './.cache/restic',
    restoreTmpDir: env.RESTORE_TMP_DIR ?? './tmp/restore',
    // Bundled into the Docker image at /app/agent-bin; overridable in dev.
    agentBinaryDir: env.AGENT_BINARY_DIR ?? 'agent-bin',
    auditRetentionDays: int(env.AUDIT_RETENTION_DAYS, 90),
    bootstrapAdminEmail: env.BOOTSTRAP_ADMIN_EMAIL ?? '',
    bootstrapAdminPassword: env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
  };
}

/** Throws when required secrets are missing outside development. */
export function validateConfig(config: AppConfig): void {
  const errors: string[] = [];

  if (!config.masterEncryptionKey) {
    errors.push('MASTER_ENCRYPTION_KEY is required');
  } else {
    const raw = Buffer.from(config.masterEncryptionKey, 'base64');
    if (raw.length !== 32) {
      errors.push('MASTER_ENCRYPTION_KEY must decode to 32 bytes (base64)');
    }
  }

  if (!config.jwtSecret) errors.push('JWT_SECRET is required');
  if (!config.databaseUrl) errors.push('DATABASE_URL is required');

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
}

export const CONFIG_TOKEN = 'APP_CONFIG';
