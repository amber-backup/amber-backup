import { Kysely } from 'kysely';

/**
 * Optional TOTP two-factor auth for local (password) accounts. The Base32 secret
 * is stored envelope-encrypted (ciphertext + nonce, like app_settings). Recovery
 * codes are stored as a jsonb array of argon2 hashes and consumed on use.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('users')
    .addColumn('totp_secret_ciphertext', 'text')
    .addColumn('totp_secret_nonce', 'text')
    .addColumn('totp_enabled', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('totp_recovery_codes', 'jsonb')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('users')
    .dropColumn('totp_secret_ciphertext')
    .dropColumn('totp_secret_nonce')
    .dropColumn('totp_enabled')
    .dropColumn('totp_recovery_codes')
    .execute();
}
