import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { loadConfig } from '../config/configuration';
import { AuthSource } from '../database/database.types';
import { AuthService } from './auth.service';
import { UsersService } from './users.service';
import {
  ResolvedProvider,
  SettingsService,
  SsoProviderType,
} from '../settings/settings.service';

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
}

/** Default login-button labels per provider type. */
const DEFAULT_LABEL: Record<SsoProviderType, string> = {
  oidc: 'SSO',
  entra: 'Microsoft',
  google: 'Google',
  github: 'GitHub',
};

/** Which AuthSource a provider maps to (only 'entra' is distinct). */
const authSourceFor = (type: SsoProviderType): AuthSource =>
  type === 'entra' ? 'entra' : 'oidc';

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

    const stateCookie = await this.jwt.signAsync(
      { providerId, state, verifier },
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
  ): Promise<{ token: string; userDisabled: boolean }> {
    if (!stateCookie) throw new UnauthorizedException('Missing SSO state');
    let parsed: { providerId: string; state: string; verifier: string };
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
        : await this.oidcProfile(provider, code, parsed.verifier);

    if (!profile.email) {
      throw new UnauthorizedException('SSO response missing email');
    }

    let user = await this.users.findByEmailRaw(profile.email);
    if (!user) {
      await this.users.create(
        { email: profile.email, displayName: profile.name, password: '' },
        authSourceFor(provider.type),
      );
      user = await this.users.findByEmailRaw(profile.email);
    }
    if (!user) throw new UnauthorizedException('Failed to provision user');

    if (user.disabled) {
      // Provisioned but not yet approved by an admin.
      return { token: '', userDisabled: true };
    }
    const result = await this.auth.issue(user.id, user.email, user.is_admin);
    return { token: result.token, userDisabled: false };
  }

  /** OIDC code exchange → id_token claims. */
  private async oidcProfile(
    provider: ResolvedProvider,
    code: string,
    verifier: string,
  ): Promise<{ email: string; name: string }> {
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
    const claims = this.decodeIdToken(tokens.id_token);
    const email = (claims.email ?? claims.preferred_username) as string;
    const name = (claims.name as string) ?? email;
    return { email, name };
  }

  /** GitHub OAuth2 code exchange → user profile (email may need a 2nd call). */
  private async githubProfile(
    provider: ResolvedProvider,
    code: string,
  ): Promise<{ email: string; name: string }> {
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
    return { email, name: gh.name || gh.login || email };
  }

  private decodeIdToken(idToken: string | undefined): Record<string, unknown> {
    if (!idToken) throw new UnauthorizedException('Missing id_token');
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('Malformed id_token');
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  }
}
