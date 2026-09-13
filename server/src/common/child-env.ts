/**
 * Environment for child processes the server spawns (restic, ssh via restic's
 * sftp.command, and user-defined job pre/post scripts).
 *
 * These processes inherit the server's environment, which holds the crown-jewel
 * secrets (the envelope master key, the JWT signing secret, the database URL).
 * A subverted restic/ssh invocation or a job script must not be able to read
 * them, so they are stripped here. Everything else (PATH, HOME, proxy and TLS
 * settings, locale, etc.) is preserved so real deployments keep working.
 */
export const SENSITIVE_ENV_KEYS = [
  'MASTER_ENCRYPTION_KEY',
  'JWT_SECRET',
  'DATABASE_URL',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'BOOTSTRAP_ADMIN_EMAIL',
];

/** Returns a copy of `base` with the server's own secrets removed. */
export function sanitizedChildEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of SENSITIVE_ENV_KEYS) delete env[key];
  return env;
}
