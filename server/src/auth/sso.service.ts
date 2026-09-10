import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import {
  KeyObject,
  constants as cryptoConstants,
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { loadConfig } from '../config/configuration';
import { User } from '../database/database.types';
import { AuthService } from './auth.service';
import { UsersService } from './users.service';
import {
  ResolvedProvider,
  SettingsService,
  SsoProviderType,
} from '../settings/settings.service';

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
}

/** A JSON Web Key as published in a provider's JWKS. */
interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

/** The identity a provider asserted about the person signing in. */
interface SsoProfile {
  /** Immutable identifier at the provider — the account is bound to this. */
  subject: string;
  email: string;
  name: string;
}

/** id_token signature algorithms accepted, mapped to their digest. */
const ID_TOKEN_ALGS: Record<string, string> = {
  RS256: 'sha256',
  RS384: 'sha384',
  RS512: 'sha512',
  PS256: 'sha256',
  PS384: 'sha384',
  PS512: 'sha512',
  ES256: 'sha256',
  ES384: 'sha384',
  ES512: 'sha512',
};

/** Tolerance for clock drift between us and the provider, in seconds. */
const CLOCK_SKEW = 60;

/**
 * Outcome of a callback. A `reason` means no session was issued: 'pending' is
 * an account still awaiting admin approval, 'local_account' one that signs in
 * with a password and must be switched to SSO by an admin first.
 */
export interface CallbackResult {
  token: string;
  reason: 'pending' | 'local_account' | null;
}

/** Default login-button labels per provider type. */
const DEFAULT_LABEL: Record<SsoProviderType, string> = {
  oidc: 'SSO',
  entra: 'Microsoft',
  google: 'Google',
  github: 'GitHub',
};

/**
 * Multi-provider SSO. OIDC / Entra / Google use the OpenID Connect
 * Authorization Code flow with PKCE (§11); GitHub uses plain OAuth2. Admins
 * configure any number of providers in the UI. New SSO users are created
 * disabled until an admin enables them; no automatic role mapping.
 */
@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);
  private discoveryCache = new Map<string, OidcDiscovery>();
  private jwksCache = new Map<string, Jwk[]>();

  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
    private readonly settingsService: SettingsService,
  ) {}

  async listProviders(): Promise<{ id: string; label: string }[]> {
    const sso = await this.settingsService.getResolvedSso();
    if (!sso.enabled) return [];
    return sso.providers
      .filter((p) => this.isConfigured(p))
      .map((p) => ({ id: p.id, label: p.label || DEFAULT_LABEL[p.type] }));
  }

  /** True when a provider has enough config to attempt a login. */
  private isConfigured(p: ResolvedProvider): boolean {
    if (!p.clientId || !p.clientSecret) return false;
    if (p.type === 'oidc') return !!p.issuerUrl;
    if (p.type === 'entra') return !!p.tenantId;
    return true;
  }

  private async resolveProvider(id: string): Promise<ResolvedProvider> {
    const sso = await this.settingsService.getResolvedSso();
    if (!sso.enabled) throw new BadRequestException('SSO is disabled');
    const provider = sso.providers.find((p) => p.id === id);
    if (!provider || !this.isConfigured(provider)) {
      throw new BadRequestException(`SSO provider '${id}' is not available`);
    }
    return provider;
  }

  /** OIDC issuer URL for discovery-based providers. */
  private issuerFor(p: ResolvedProvider): string {
    switch (p.type) {
      case 'oidc':
        return p.issuerUrl;
      case 'entra':
        return `https://login.microsoftonline.com/${p.tenantId}/v2.0`;
      case 'google':
        return 'https://accounts.google.com';
      default:
        throw new BadRequestException(`Provider '${p.type}' is not OIDC`);
    }
  }

  private async discover(issuer: string): Promise<OidcDiscovery> {
    const cached = this.discoveryCache.get(issuer);
    if (cached) return cached;
    const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) throw new BadRequestException('OIDC discovery failed');
    const doc = (await res.json()) as OidcDiscovery;
    this.discoveryCache.set(issuer, doc);
    return doc;
  }

  private redirectUri(): string {
    return `${loadConfig().publicBaseUrl.replace(/\/$/, '')}/api/auth/callback`;
  }

  /** Builds the authorization URL and a signed state cookie value. */
  async startLogin(
    providerId: string,
  ): Promise<{ authUrl: string; stateCookie: string }> {
    const provider = await this.resolveProvider(providerId);

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('base64url');
    // Binds the id_token to this authorization request; verified in the callback.
    const nonce = randomBytes(16).toString('base64url');

    const stateCookie = await this.jwt.signAsync(
      { providerId, state, verifier, nonce },
      { secret: loadConfig().jwtSecret, expiresIn: '10m' },
    );

    if (provider.type === 'github') {
      const params = new URLSearchParams({
        client_id: provider.clientId,
        redirect_uri: this.redirectUri(),
        scope: 'read:user user:email',
        state,
      });
      return {
        authUrl: `https://github.com/login/oauth/authorize?${params.toString()}`,
        stateCookie,
      };
    }

    const disco = await this.discover(this.issuerFor(provider));
    const params = new URLSearchParams({
      client_id: provider.clientId,
      response_type: 'code',
      scope: 'openid email profile',
      redirect_uri: this.redirectUri(),
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return {
      authUrl: `${disco.authorization_endpoint}?${params.toString()}`,
      stateCookie,
    };
  }

  /** Handles the OAuth/OIDC callback: verifies state, resolves the user. */
  async handleCallback(
    code: string,
    state: string,
    stateCookie: string | undefined,
  ): Promise<CallbackResult> {
    if (!stateCookie) throw new UnauthorizedException('Missing SSO state');
    let parsed: {
      providerId: string;
      state: string;
      verifier: string;
      nonce?: string;
    };
    try {
      parsed = await this.jwt.verifyAsync(stateCookie, {
        secret: loadConfig().jwtSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid SSO state');
    }
    if (parsed.state !== state) {
      throw new UnauthorizedException('SSO state mismatch');
    }

    const provider = await this.resolveProvider(parsed.providerId);
    const profile =
      provider.type === 'github'
        ? await this.githubProfile(provider, code)
        : await this.oidcProfile(provider, code, parsed.verifier, parsed.nonce);

    if (!profile.subject) {
      throw new UnauthorizedException('SSO response missing subject');
    }
    if (!profile.email) {
      throw new UnauthorizedException('SSO response missing email');
    }

    const user = await this.resolveUser(provider, profile);
    if (user === 'local_account') return { token: '', reason: 'local_account' };

    if (user.disabled) {
      // Provisioned but not yet approved by an admin.
      return { token: '', reason: 'pending' };
    }
    void this.users.touchSsoIdentity(provider.id, profile.subject);
    const result = await this.auth.issue(user.id, user.email, user.is_admin);
    return { token: result.token, reason: null };
  }

  /**
   * Resolves the account behind an asserted identity.
   *
   * The provider's subject is the authority: once bound, that pair alone
   * decides who signs in. An e-mail match only ever *creates* the binding, and
   * never for a local account — otherwise any provider that claims an address
   * could take over the password-protected account holding it.
   */
  private async resolveUser(
    provider: ResolvedProvider,
    profile: SsoProfile,
  ): Promise<User | 'local_account'> {
    const bound = await this.users.findBySsoIdentity(provider.id, profile.subject);
    if (bound) {
      // The account may have been switched back to local login since.
      return bound.auth_source === 'local' ? 'local_account' : bound;
    }

    const byEmail = await this.users.findByEmailRaw(profile.email);
    if (byEmail) {
      if (byEmail.auth_source === 'local') return 'local_account';
      await this.users.linkSsoIdentity(byEmail.id, provider.id, profile.subject);
      return byEmail;
    }

    await this.users.create(
      { email: profile.email, displayName: profile.name, password: '' },
      'sso',
    );
    const created = await this.users.findByEmailRaw(profile.email);
    if (!created) throw new UnauthorizedException('Failed to provision user');
    await this.users.linkSsoIdentity(created.id, provider.id, profile.subject);
    return created;
  }

  /** OIDC code exchange → id_token claims. */
  private async oidcProfile(
    provider: ResolvedProvider,
    code: string,
    verifier: string,
    nonce: string | undefined,
  ): Promise<SsoProfile> {
    const disco = await this.discover(this.issuerFor(provider));
    const tokenRes = await fetch(disco.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri(),
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code_verifier: verifier,
      }),
    });
    if (!tokenRes.ok) {
      this.logger.warn(`Token exchange failed: ${await tokenRes.text()}`);
      throw new UnauthorizedException('SSO token exchange failed');
    }
    const tokens = (await tokenRes.json()) as { id_token?: string };
    const claims = await this.verifyIdToken(
      provider,
      disco,
      tokens.id_token,
      nonce,
    );
    const email = (claims.email ?? claims.preferred_username) as string;
    const name = (claims.name as string) ?? email;
    return { subject: String(claims.sub ?? ''), email, name };
  }

  /** GitHub OAuth2 code exchange → user profile (email may need a 2nd call). */
  private async githubProfile(
    provider: ResolvedProvider,
    code: string,
  ): Promise<SsoProfile> {
    const tokenRes = await fetch(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
          code,
          redirect_uri: this.redirectUri(),
        }),
      },
    );
    if (!tokenRes.ok) {
      this.logger.warn(`GitHub token exchange failed: ${await tokenRes.text()}`);
      throw new UnauthorizedException('SSO token exchange failed');
    }
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) {
      throw new UnauthorizedException('SSO token exchange failed');
    }

    const ghHeaders = {
      authorization: `Bearer ${token.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'amber-backup',
    };
    const userRes = await fetch('https://api.github.com/user', {
      headers: ghHeaders,
    });
    if (!userRes.ok) throw new UnauthorizedException('GitHub profile fetch failed');
    const gh = (await userRes.json()) as {
      id?: number;
      email?: string | null;
      name?: string | null;
      login?: string;
    };

    let email = gh.email ?? '';
    if (!email) {
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: ghHeaders,
      });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as {
          email: string;
          primary: boolean;
          verified: boolean;
        }[];
        email =
          emails.find((e) => e.primary && e.verified)?.email ??
          emails.find((e) => e.verified)?.email ??
          '';
      }
    }
    return {
      // GitHub's numeric id is stable across renames, unlike the login.
      subject: gh.id != null ? String(gh.id) : '',
      email,
      name: gh.name || gh.login || email,
    };
  }

  /**
   * Verifies an id_token the way OIDC core §3.1.3.7 requires: the signature
   * against the provider's published JWKS, then issuer, audience, expiry and
   * the nonce from our own authorization request. The token arrives over TLS
   * from the token endpoint, but that alone says nothing about who minted it.
   */
  private async verifyIdToken(
    provider: ResolvedProvider,
    disco: OidcDiscovery,
    idToken: string | undefined,
    nonce: string | undefined,
  ): Promise<Record<string, unknown>> {
    if (!idToken) throw new UnauthorizedException('Missing id_token');
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('Malformed id_token');

    const header = parseSegment(parts[0]);
    const alg = String(header.alg ?? '');
    const digest = ID_TOKEN_ALGS[alg];
    // 'none' and the HMAC family would let anyone who knows the client secret
    // (or nobody at all) mint a token.
    if (!digest) {
      throw new UnauthorizedException(`Unsupported id_token algorithm: ${alg}`);
    }

    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    const kid = typeof header.kid === 'string' ? header.kid : undefined;

    // Signing keys rotate, so an unknown `kid` is worth one fresh fetch. A key
    // we do know that simply fails to verify is a bad token, not a stale cache.
    let keys = await this.jwks(disco.jwks_uri, false);
    if (kid && !keys.some((k) => k.kid === kid)) {
      keys = await this.jwks(disco.jwks_uri, true);
    }
    if (!verifyWithKeys(keys, kid, alg, digest, signed, signature)) {
      throw new UnauthorizedException('id_token signature is not valid');
    }

    const claims = parseSegment(parts[1]);
    const now = Math.floor(Date.now() / 1000);

    if (claims.iss !== disco.issuer) {
      throw new UnauthorizedException('id_token issuer mismatch');
    }
    const aud = claims.aud;
    const audienceOk = Array.isArray(aud)
      ? aud.includes(provider.clientId)
      : aud === provider.clientId;
    if (!audienceOk) {
      throw new UnauthorizedException('id_token audience mismatch');
    }
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW < now) {
      throw new UnauthorizedException('id_token has expired');
    }
    if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW > now) {
      throw new UnauthorizedException('id_token is not valid yet');
    }
    // Older sessions started before nonces were sent carry none; only compare
    // when we actually asked for one.
    if (nonce && claims.nonce !== nonce) {
      throw new UnauthorizedException('id_token nonce mismatch');
    }
    return claims;
  }

  private async jwks(uri: string, refresh: boolean): Promise<Jwk[]> {
    if (!refresh) {
      const cached = this.jwksCache.get(uri);
      if (cached) return cached;
    }
    const res = await fetch(uri);
    if (!res.ok) {
      throw new UnauthorizedException('Could not fetch the provider signing keys');
    }
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = body.keys ?? [];
    this.jwksCache.set(uri, keys);
    return keys;
  }
}

/** True as soon as one candidate key verifies the signature. */
function verifyWithKeys(
  keys: Jwk[],
  kid: string | undefined,
  alg: string,
  digest: string,
  signed: Buffer,
  signature: Buffer,
): boolean {
  const named = kid ? keys.filter((k) => k.kid === kid) : [];
  for (const jwk of named.length ? named : keys) {
    let key: KeyObject;
    try {
      key = createPublicKey({ key: jwk as never, format: 'jwk' });
    } catch {
      continue;
    }
    const options = alg.startsWith('PS')
      ? {
          key,
          padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
          saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
        }
      : alg.startsWith('ES')
        ? { key, dsaEncoding: 'ieee-p1363' as const }
        : { key };
    try {
      if (verifySignature(digest, signed, options, signature)) return true;
    } catch {
      /* wrong key type for this algorithm — try the next one */
    }
  }
  return false;
}

function parseSegment(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new UnauthorizedException('Malformed id_token');
  }
}
