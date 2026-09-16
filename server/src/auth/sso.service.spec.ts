import { generateKeyPairSync, sign as signData } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { TEST_MASTER_KEY } from '../testing/db-mock';

process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;
process.env.JWT_SECRET = 'test-jwt-secret-value';
process.env.PUBLIC_BASE_URL = 'https://amber.example';

import { SsoService } from './sso.service';
import { AuthService } from './auth.service';
import { UsersService } from './users.service';
import { SettingsService } from '../settings/settings.service';
import { User } from '../database/database.types';

// otplib is ESM and Jest doesn't transform it; AuthService only needs the type.
jest.mock('./totp.service', () => ({ TotpService: class TotpService {} }));

const ISSUER = 'https://issuer.example';
const CLIENT_ID = 'amber-client';
const PROVIDER = {
  id: 'p1',
  type: 'oidc' as const,
  label: '',
  clientId: CLIENT_ID,
  clientSecret: 'shh',
  issuerUrl: ISSUER,
  tenantId: '',
};

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };

interface TokenOverrides {
  aud?: string;
  exp?: number;
  nonce?: string | null;
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  key?: typeof privateKey;
}

/** Mints an id_token the way the provider would, with room to break one field. */
function idToken(nonce: string, o: TokenOverrides = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'k1', typ: 'JWT' };
  const claims: Record<string, unknown> = {
    iss: ISSUER,
    aud: o.aud ?? CLIENT_ID,
    sub: o.sub ?? 'subject-1',
    email: o.email ?? 'person@example.com',
    email_verified: o.emailVerified ?? true,
    name: 'A Person',
    iat: now,
    exp: o.exp ?? now + 300,
  };
  if (o.nonce !== null) claims.nonce = o.nonce ?? nonce;
  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString('base64url');
  const signing = `${b64(header)}.${b64(claims)}`;
  const signature = signData('sha256', Buffer.from(signing), o.key ?? privateKey);
  return `${signing}.${signature.toString('base64url')}`;
}

function makeUser(over: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'person@example.com',
    display_name: 'A Person',
    auth_source: 'sso',
    disabled: false,
    is_admin: false,
    ...over,
  } as User;
}

describe('SsoService (callback)', () => {
  let service: SsoService;
  let jwt: JwtService;
  let users: {
    findBySsoIdentity: jest.Mock;
    findByEmailRaw: jest.Mock;
    linkSsoIdentity: jest.Mock;
    touchSsoIdentity: jest.Mock;
    create: jest.Mock;
  };
  let auth: { issue: jest.Mock };
  let fetchMock: jest.Mock;

  /** The id_token the mocked token endpoint hands back for the next exchange. */
  let issuedToken = '';

  /** Runs a full round trip and returns whatever the callback decided. */
  async function callback(token: string | ((nonce: string) => string)) {
    const { stateCookie } = await service.startLogin(PROVIDER.id);
    const parsed = await jwt.verifyAsync<{ state: string; nonce: string }>(
      stateCookie,
      { secret: process.env.JWT_SECRET },
    );
    issuedToken = typeof token === 'function' ? token(parsed.nonce) : token;
    return service.handleCallback('the-code', parsed.state, stateCookie);
  }

  function respond(url: string, token: string) {
    if (url.includes('.well-known/openid-configuration')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
          }),
      });
    }
    if (url.includes('/jwks')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ keys: [jwk] }) });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ id_token: token }),
      text: () => Promise.resolve(''),
    });
  }

  beforeEach(() => {
    jwt = new JwtService({});
    users = {
      findBySsoIdentity: jest.fn().mockResolvedValue(undefined),
      findByEmailRaw: jest.fn().mockResolvedValue(undefined),
      linkSsoIdentity: jest.fn().mockResolvedValue(undefined),
      touchSsoIdentity: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
    };
    auth = { issue: jest.fn().mockResolvedValue({ token: 'session-jwt' }) };
    issuedToken = '';
    fetchMock = jest.fn((url: string) => respond(url, issuedToken));
    global.fetch = fetchMock as unknown as typeof fetch;

    service = new SsoService(
      users as unknown as UsersService,
      auth as unknown as AuthService,
      jwt,
      {
        getResolvedSso: jest
          .fn()
          .mockResolvedValue({ enabled: true, providers: [PROVIDER] }),
      } as unknown as SettingsService,
    );
  });

  describe('identity binding', () => {
    it('signs in the account bound to the provider subject', async () => {
      users.findBySsoIdentity.mockResolvedValue(makeUser());

      const result = await callback((n) => idToken(n));

      expect(result).toEqual({
        token: 'session-jwt',
        reason: null,
        user: { email: 'person@example.com', isAdmin: false },
      });
      expect(users.findBySsoIdentity).toHaveBeenCalledWith('p1', 'subject-1');
      // The subject decided it — no e-mail lookup was needed.
      expect(users.findByEmailRaw).not.toHaveBeenCalled();
    });

    it('refuses to sign in a local account that merely shares the e-mail', async () => {
      users.findByEmailRaw.mockResolvedValue(makeUser({ auth_source: 'local' }));

      const result = await callback((n) => idToken(n));

      expect(result).toEqual({ token: '', reason: 'local_account' });
      expect(auth.issue).not.toHaveBeenCalled();
      expect(users.linkSsoIdentity).not.toHaveBeenCalled();
    });

    it('refuses a bound identity whose account was switched back to local', async () => {
      users.findBySsoIdentity.mockResolvedValue(makeUser({ auth_source: 'local' }));

      const result = await callback((n) => idToken(n));

      expect(result).toEqual({ token: '', reason: 'local_account' });
      expect(auth.issue).not.toHaveBeenCalled();
    });

    it('binds the subject on the first login of an SSO account', async () => {
      users.findByEmailRaw.mockResolvedValue(makeUser());

      const result = await callback((n) => idToken(n));

      expect(result.reason).toBeNull();
      expect(users.linkSsoIdentity).toHaveBeenCalledWith('u1', 'p1', 'subject-1');
    });

    it('provisions an unknown e-mail as a disabled account awaiting approval', async () => {
      users.findByEmailRaw
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(makeUser({ disabled: true }));

      const result = await callback((n) => idToken(n));

      expect(users.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'person@example.com' }),
        'sso',
      );
      expect(result).toEqual({ token: '', reason: 'pending' });
    });

    it('refuses to link or provision when the email is not verified', async () => {
      users.findBySsoIdentity.mockResolvedValue(undefined);
      users.findByEmailRaw.mockResolvedValue(undefined);

      await expect(
        callback((n) => idToken(n, { emailVerified: false })),
      ).rejects.toMatchObject({ status: 401 });
      expect(users.linkSsoIdentity).not.toHaveBeenCalled();
      expect(users.create).not.toHaveBeenCalled();
    });
  });

  describe('id_token verification', () => {
    beforeEach(() => users.findBySsoIdentity.mockResolvedValue(makeUser()));

    it('rejects a token signed by a key the provider does not publish', async () => {
      await expect(
        callback((n) => idToken(n, { key: otherKey.privateKey })),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects a token whose payload was altered after signing', async () => {
      await expect(
        callback((n) => {
          const [h, , s] = idToken(n).split('.');
          const forged = Buffer.from(
            JSON.stringify({ iss: ISSUER, aud: CLIENT_ID, sub: 'attacker' }),
          ).toString('base64url');
          return `${h}.${forged}.${s}`;
        }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects a token minted for a different client', async () => {
      await expect(
        callback((n) => idToken(n, { aud: 'someone-else' })),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects an expired token', async () => {
      const past = Math.floor(Date.now() / 1000) - 3600;
      await expect(callback((n) => idToken(n, { exp: past }))).rejects.toMatchObject(
        { status: 401 },
      );
    });

    it('rejects a token replayed from another authorization request', async () => {
      await expect(
        callback(() => idToken('', { nonce: 'a-different-nonce' })),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects an unsigned token', async () => {
      await expect(
        callback((n) => {
          const [, p] = idToken(n).split('.');
          const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
            'base64url',
          );
          return `${header}.${p}.`;
        }),
      ).rejects.toMatchObject({ status: 401 });
    });
  });
});
