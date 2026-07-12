import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { loadConfig } from '../config/configuration';
import { PublicUser, UsersService } from './users.service';
import { TotpService } from './totp.service';

export interface AuthResult {
  token: string;
  user: PublicUser;
}

/** Login either completes, or pauses for a TOTP second factor. */
export type LoginOutcome =
  | ({ status: 'ok' } & AuthResult)
  | { status: '2fa_required'; challengeToken: string };

interface ChallengePayload {
  sub: string;
  twofa: true;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly totp: TotpService,
  ) {}

  /**
   * Challenge tokens are signed with a key derived from — but distinct from —
   * the session secret, so a challenge token can never be replayed as a session
   * cookie (the AuthGuard verifies with the plain jwtSecret and would reject it).
   */
  private challengeSecret(): string {
    return `${loadConfig().jwtSecret}::totp-challenge`;
  }

  async login(email: string, password: string): Promise<LoginOutcome> {
    const user = await this.users.findByEmailRaw(email);
    if (!user || user.auth_source !== 'local') {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.disabled) throw new UnauthorizedException('Account disabled');
    if (!(await this.users.verifyPassword(user, password))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.totp_enabled) {
      const challengeToken = await this.jwt.signAsync(
        { sub: user.id, twofa: true } satisfies ChallengePayload,
        { secret: this.challengeSecret(), expiresIn: '5m' },
      );
      return { status: '2fa_required', challengeToken };
    }
    return { status: 'ok', ...(await this.issue(user.id, user.email, user.is_admin)) };
  }

  /** Second step of a 2FA login: validate the challenge + code, then mint a session. */
  async loginTotp(challengeToken: string, code: string): Promise<AuthResult> {
    let payload: ChallengePayload;
    try {
      payload = await this.jwt.verifyAsync<ChallengePayload>(challengeToken, {
        secret: this.challengeSecret(),
      });
    } catch {
      throw new UnauthorizedException('Two-factor session expired — sign in again');
    }
    if (!payload?.twofa || !payload.sub) {
      throw new UnauthorizedException('Invalid two-factor session');
    }
    const user = await this.users.findByIdRaw(payload.sub);
    if (!user || user.disabled || !user.totp_enabled) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!(await this.totp.verifyLogin(user, code))) {
      throw new UnauthorizedException('Invalid authentication code');
    }
    return this.issue(user.id, user.email, user.is_admin);
  }

  /** Mints a session for a user proven by an external factor (e.g. a passkey). */
  async issueForUser(userId: string): Promise<AuthResult> {
    const user = await this.users.findByIdRaw(userId);
    if (!user || user.disabled) {
      throw new UnauthorizedException('Account is not available');
    }
    return this.issue(user.id, user.email, user.is_admin);
  }

  /** Issues a session JWT for an already-authenticated user (also used by SSO). */
  async issue(
    id: string,
    email: string,
    isAdmin: boolean,
  ): Promise<AuthResult> {
    const config = loadConfig();
    const signOptions = {
      secret: config.jwtSecret,
      expiresIn: config.jwtExpiresIn,
    } as Parameters<JwtService['signAsync']>[1];
    const token = await this.jwt.signAsync({ sub: id, email, isAdmin }, signOptions);
    const user = await this.users.findById(id);
    return { token, user };
  }
}
