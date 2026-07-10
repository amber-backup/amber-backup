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

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
}

interface ProviderSettings {
  source: AuthSource;
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Generic OIDC + Microsoft Entra ID login using the Authorization Code flow
 * with PKCE (§11). New SSO users are created disabled until an admin enables
 * them; no automatic role mapping.
 */
@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);
  private discoveryCache = new Map<string, OidcDiscovery>();

  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
  ) {}

  listProviders(): { id: string; label: string }[] {
    const config = loadConfig();
    const providers: { id: string; label: string }[] = [];
    if (config.oidc.enabled) providers.push({ id: 'oidc', label: 'SSO' });
    if (config.entra.enabled)
      providers.push({ id: 'entra', label: 'Microsoft' });
    return providers;
  }

  private settings(provider: string): ProviderSettings {
    const config = loadConfig();
    if (provider === 'oidc' && config.oidc.enabled) {
      return {
        source: 'oidc',
        issuer: config.oidc.issuerUrl,
        clientId: config.oidc.clientId,
        clientSecret: config.oidc.clientSecret,
      };
    }
    if (provider === 'entra' && config.entra.enabled) {
      return {
        source: 'entra',
        issuer: `https://login.microsoftonline.com/${config.entra.tenantId}/v2.0`,
        clientId: config.entra.clientId,
        clientSecret: config.entra.clientSecret,
      };
    }
    throw new BadRequestException(`SSO provider '${provider}' not enabled`);
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
    provider: string,
  ): Promise<{ authUrl: string; stateCookie: string }> {
    const settings = this.settings(provider);
    const disco = await this.discover(settings.issuer);

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256')
      .update(verifier)
      .digest('base64url');
    const state = randomBytes(16).toString('base64url');

    const stateCookie = await this.jwt.signAsync(
      { provider, state, verifier },
      { secret: loadConfig().jwtSecret, expiresIn: '10m' },
    );

    const params = new URLSearchParams({
      client_id: settings.clientId,
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

  /** Handles the OIDC callback: verifies state, exchanges code, upserts user. */
  async handleCallback(
    code: string,
    state: string,
    stateCookie: string | undefined,
  ): Promise<{ token: string; userDisabled: boolean }> {
    if (!stateCookie) throw new UnauthorizedException('Missing SSO state');
    let parsed: { provider: string; state: string; verifier: string };
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

    const settings = this.settings(parsed.provider);
    const disco = await this.discover(settings.issuer);

    const tokenRes = await fetch(disco.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri(),
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        code_verifier: parsed.verifier,
      }),
    });
    if (!tokenRes.ok) {
      this.logger.warn(`Token exchange failed: ${await tokenRes.text()}`);
      throw new UnauthorizedException('SSO token exchange failed');
    }
    const tokens = (await tokenRes.json()) as { id_token?: string };
    const claims = this.decodeIdToken(tokens.id_token);

    const email = (claims.email ?? claims.preferred_username) as string;
    if (!email) throw new UnauthorizedException('SSO response missing email');
    const name = (claims.name as string) ?? email;

    let user = await this.users.findByEmailRaw(email);
    if (!user) {
      await this.users.create(
        { email, displayName: name, password: '' },
        settings.source,
      );
      user = await this.users.findByEmailRaw(email);
    }
    if (!user) throw new UnauthorizedException('Failed to provision user');

    if (user.disabled) {
      // Provisioned but not yet approved by an admin.
      return { token: '', userDisabled: true };
    }
    const result = await this.auth.issue(user.id, user.email, user.is_admin);
    return { token: result.token, userDisabled: false };
  }

  private decodeIdToken(idToken: string | undefined): Record<string, unknown> {
    if (!idToken) throw new UnauthorizedException('Missing id_token');
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('Malformed id_token');
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  }
}
