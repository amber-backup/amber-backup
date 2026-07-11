import { TEST_MASTER_KEY } from '../testing/db-mock';

// CryptoService reads MASTER_ENCRYPTION_KEY from the environment at construction.
process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { CryptoService } from './crypto.service';

describe('CryptoService', () => {
  let crypto: CryptoService;

  beforeEach(() => {
    process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;
    crypto = new CryptoService();
  });

  describe('encrypt / decrypt (AES-256-GCM)', () => {
    it('round-trips plaintext', () => {
      const plaintext = 'super-secret-repo-password';
      const payload = crypto.encrypt(plaintext);
      expect(crypto.decrypt(payload)).toBe(plaintext);
    });

    it('round-trips empty, unicode and long strings', () => {
      for (const plaintext of ['', 'pässwörd–✓🔐', 'x'.repeat(10_000)]) {
        expect(crypto.decrypt(crypto.encrypt(plaintext))).toBe(plaintext);
      }
    });

    it('never emits the plaintext in the ciphertext', () => {
      const plaintext = 'plaintext-marker';
      const { ciphertext, nonce } = crypto.encrypt(plaintext);
      expect(ciphertext).not.toContain(plaintext);
      expect(Buffer.from(ciphertext, 'base64').toString('utf8')).not.toContain(
        plaintext,
      );
      expect(nonce).toBeTruthy();
    });

    it('uses a fresh random nonce per call (non-deterministic ciphertext)', () => {
      const a = crypto.encrypt('same-input');
      const b = crypto.encrypt('same-input');
      expect(a.nonce).not.toBe(b.nonce);
      expect(a.ciphertext).not.toBe(b.ciphertext);
      // A 12-byte IV → 16 base64 chars.
      expect(Buffer.from(a.nonce, 'base64')).toHaveLength(12);
    });

    it('rejects a tampered ciphertext (GCM auth tag)', () => {
      const payload = crypto.encrypt('integrity-protected');
      const raw = Buffer.from(payload.ciphertext, 'base64');
      raw[raw.length - 1] ^= 0xff; // flip a bit in the ciphertext body
      const tampered = { ...payload, ciphertext: raw.toString('base64') };
      expect(() => crypto.decrypt(tampered)).toThrow();
    });

    it('rejects a tampered auth tag', () => {
      const payload = crypto.encrypt('integrity-protected');
      const raw = Buffer.from(payload.ciphertext, 'base64');
      raw[0] ^= 0xff; // the first 16 bytes are the auth tag
      const tampered = { ...payload, ciphertext: raw.toString('base64') };
      expect(() => crypto.decrypt(tampered)).toThrow();
    });

    it('rejects a mismatched nonce', () => {
      const payload = crypto.encrypt('bound-to-nonce');
      const otherNonce = crypto.encrypt('anything').nonce;
      expect(() => crypto.decrypt({ ...payload, nonce: otherNonce })).toThrow();
    });

    it('cannot be decrypted with a different master key', () => {
      const payload = crypto.encrypt('key-bound');
      process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString('base64');
      const other = new CryptoService();
      process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;
      expect(() => other.decrypt(payload)).toThrow();
    });
  });

  describe('hashToken', () => {
    it('is a deterministic 64-char hex SHA-256', () => {
      const hash = crypto.hashToken('token-abc');
      expect(hash).toBe(crypto.hashToken('token-abc'));
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('differs for different inputs', () => {
      expect(crypto.hashToken('a')).not.toBe(crypto.hashToken('b'));
    });
  });

  describe('safeCompareHash', () => {
    it('returns true for equal hashes', () => {
      const h = crypto.hashToken('x');
      expect(crypto.safeCompareHash(h, h)).toBe(true);
    });

    it('returns false for different hashes of equal length', () => {
      expect(
        crypto.safeCompareHash(crypto.hashToken('x'), crypto.hashToken('y')),
      ).toBe(false);
    });

    it('returns false (no throw) for different-length inputs', () => {
      expect(crypto.safeCompareHash('short', 'a-much-longer-value')).toBe(false);
    });
  });

  describe('generateToken', () => {
    it('returns url-safe base64 of the requested byte length', () => {
      const token = crypto.generateToken(32);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    });

    it('defaults to 32 bytes', () => {
      expect(Buffer.from(crypto.generateToken(), 'base64url')).toHaveLength(32);
    });

    it('produces unique tokens', () => {
      const tokens = new Set(
        Array.from({ length: 100 }, () => crypto.generateToken(16)),
      );
      expect(tokens.size).toBe(100);
    });
  });
});
