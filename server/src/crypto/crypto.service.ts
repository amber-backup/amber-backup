import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  createHash,
} from 'crypto';
import { loadConfig } from '../config/configuration';

export interface EncryptedPayload {
  /** base64: iv(12) + authTag(16) + ciphertext */
  ciphertext: string;
  /** base64 nonce, stored separately per schema */
  nonce: string;
}

/**
 * Symmetric encryption of secrets at rest using AES-256-GCM.
 * The 32-byte master key comes from the environment and never touches the DB.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor() {
    const config = loadConfig();
    this.key = Buffer.from(config.masterEncryptionKey, 'base64');
  }

  encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([authTag, enc]).toString('base64'),
      nonce: iv.toString('base64'),
    };
  }

  decrypt(payload: EncryptedPayload): string {
    const iv = Buffer.from(payload.nonce, 'base64');
    const raw = Buffer.from(payload.ciphertext, 'base64');
    const authTag = raw.subarray(0, 16);
    const enc = raw.subarray(16);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  }

  /** Deterministic SHA-256 hash (hex) for tokens/api keys lookup + compare. */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Constant-time comparison of two hex hashes. */
  safeCompareHash(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }

  /** Generate a random opaque token, returned as url-safe base64. */
  generateToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }
}
