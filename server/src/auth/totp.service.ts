import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { generateSecret, generateURI, verify } from 'otplib';
import * as QRCode from 'qrcode';
import { Db, KYSELY } from '../database/database.module';
import { CryptoService } from '../crypto/crypto.service';
import { User } from '../database/database.types';

const ISSUER = 'Amber Backup';
/** Tolerate ±30s of clock drift between the server and the authenticator app. */
const EPOCH_TOLERANCE = 30;
const RECOVERY_CODE_COUNT = 10;

export interface TotpSetup {
  /** Base32 secret for manual entry. */
  secret: string;
  /** otpauth:// URI encoded in the QR image. */
  otpauthUri: string;
  /** PNG data URL of the QR code to scan. */
  qrDataUrl: string;
}

/**
 * TOTP two-factor authentication for local accounts. The Base32 secret is
 * envelope-encrypted at rest; recovery codes are stored as argon2 hashes and
 * consumed on use. Setup stores a pending secret; it only becomes active once
 * the user proves possession by entering a valid code (`enable`).
 */
@Injectable()
export class TotpService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly crypto: CryptoService,
  ) {}

  private async loadLocalUser(userId: string): Promise<User> {
    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new NotFoundException('User not found');
    if (user.auth_source !== 'local') {
      throw new BadRequestException(
        'Two-factor authentication is only available for password accounts',
      );
    }
    return user;
  }

  private decryptSecret(user: User): string | null {
    if (!user.totp_secret_ciphertext || !user.totp_secret_nonce) return null;
    return this.crypto.decrypt({
      ciphertext: user.totp_secret_ciphertext,
      nonce: user.totp_secret_nonce,
    });
  }

  /**
   * Generates a fresh secret and stores it (pending, not yet enabled), returning
   * the provisioning URI + QR image. Re-running before enabling rotates the
   * pending secret; it is refused once 2FA is already active.
   */
  async setup(userId: string): Promise<TotpSetup> {
    const user = await this.loadLocalUser(userId);
    if (user.totp_enabled) {
      throw new BadRequestException('Two-factor authentication is already enabled');
    }
    const secret = generateSecret();
    const enc = this.crypto.encrypt(secret);
    await this.db
      .updateTable('users')
      .set({
        totp_secret_ciphertext: enc.ciphertext,
        totp_secret_nonce: enc.nonce,
        updated_at: new Date(),
      })
      .where('id', '=', userId)
      .execute();

    const otpauthUri = generateURI({ issuer: ISSUER, label: user.email, secret });
    const qrDataUrl = await QRCode.toDataURL(otpauthUri, { margin: 1, width: 220 });
    return { secret, otpauthUri, qrDataUrl };
  }

  /**
   * Confirms the pending secret with a live code, activates 2FA, and returns a
   * fresh set of one-time recovery codes (shown to the user only here).
   */
  async enable(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const user = await this.loadLocalUser(userId);
    if (user.totp_enabled) {
      throw new BadRequestException('Two-factor authentication is already enabled');
    }
    const secret = this.decryptSecret(user);
    if (!secret) {
      throw new BadRequestException('Start the setup before enabling two-factor auth');
    }
    if (!(await this.verifyToken(code, secret))) {
      throw new UnauthorizedException('Invalid authentication code');
    }

    const recoveryCodes = this.generateRecoveryCodes();
    const hashes = await Promise.all(
      recoveryCodes.map((c) => argon2.hash(this.canonical(c))),
    );
    await this.db
      .updateTable('users')
      .set({
        totp_enabled: true,
        totp_recovery_codes: JSON.stringify(hashes),
        updated_at: new Date(),
      })
      .where('id', '=', userId)
      .execute();

    return { recoveryCodes };
  }

  /** Turns 2FA off after the user re-confirms their password, wiping all secrets. */
  async disable(userId: string, password: string): Promise<void> {
    const user = await this.loadLocalUser(userId);
    if (!user.password_hash || !(await this.verifyArgon(user.password_hash, password))) {
      throw new UnauthorizedException('Password is incorrect');
    }
    await this.db
      .updateTable('users')
      .set({
        totp_enabled: false,
        totp_secret_ciphertext: null,
        totp_secret_nonce: null,
        totp_recovery_codes: null,
        updated_at: new Date(),
      })
      .where('id', '=', userId)
      .execute();
  }

  /**
   * Login-time check: accepts either a 6-digit TOTP code or a one-time recovery
   * code (which is consumed on success). Returns false for anything invalid.
   */
  async verifyLogin(user: User, code: string): Promise<boolean> {
    if (!user.totp_enabled) return false;
    const secret = this.decryptSecret(user);
    if (!secret) return false;

    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed)) {
      return this.verifyToken(trimmed, secret);
    }
    return this.consumeRecoveryCode(user, trimmed);
  }

  // --- internals ------------------------------------------------------------

  private async verifyToken(token: string, secret: string): Promise<boolean> {
    try {
      const result = await verify({
        token: token.trim(),
        secret,
        epochTolerance: EPOCH_TOLERANCE,
      });
      return result.valid;
    } catch {
      return false;
    }
  }

  private async verifyArgon(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /** Normalizes a recovery code for hashing/compare (case- and format-agnostic). */
  private canonical(code: string): string {
    return code.replace(/[^a-z0-9]/gi, '').toLowerCase();
  }

  private generateRecoveryCodes(): string[] {
    const codes: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const raw = randomBytes(5).toString('hex'); // 10 hex chars
      codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
    }
    return codes;
  }

  private async consumeRecoveryCode(user: User, code: string): Promise<boolean> {
    const hashes: string[] =
      typeof user.totp_recovery_codes === 'string'
        ? JSON.parse(user.totp_recovery_codes)
        : (user.totp_recovery_codes ?? []);
    if (hashes.length === 0) return false;

    const candidate = this.canonical(code);
    if (!candidate) return false;

    for (let i = 0; i < hashes.length; i++) {
      if (await this.verifyArgon(hashes[i], candidate)) {
        const remaining = hashes.filter((_, idx) => idx !== i);
        await this.db
          .updateTable('users')
          .set({
            totp_recovery_codes: JSON.stringify(remaining),
            updated_at: new Date(),
          })
          .where('id', '=', user.id)
          .execute();
        return true;
      }
    }
    return false;
  }
}
