import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { loadConfig } from '../config/configuration';
import { SettingsService } from '../settings/settings.service';
import { PublicUser, UsersService } from './users.service';
import { TotpService } from './totp.service';

/** Max TOTP/recovery guesses accepted against a single challenge token. */
const MAX_TOTP_ATTEMPTS = 5;
/** A challenge is valid for 5 minutes; drop tracking entries a little after. */
const CHALLENGE_TTL_MS = 6 * 60_000;

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
  /** Unique id so a challenge can be attempt-capped and burned after use. */
  jti: string;
}

@Injectable()
export class AuthService {
  /**
   * Per-challenge guard against TOTP brute force: a challenge token (5 min
   * lifetime) accepts at most MAX_TOTP_ATTEMPTS codes and is burned on the
   * first success, so an attacker who phished a password cannot iterate the
   * 6-digit space by replaying one challenge. In-memory is sufficient — the
   * window is short and entries self-expire; combined with request rate
   * limiting on the endpoint it closes the brute-force path.
   */
  private readonly challengeState = new Map<
    string,
    { attempts: number; expiresAt: number }
  >();

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly totp: TotpService,
    private readonly settings: SettingsService,
  ) {}

  /** Registers a guess against a challenge; returns false once it is spent. */
  private consumeAttempt(jti: string): boolean {
    const now = Date.now();
    for (const [k, v] of this.challengeState) {
      if (v.expiresAt <= now) this.challengeState.delete(k);
    }
    const entry = this.challengeState.get(jti) ?? {
      attempts: 0,
      expiresAt: now + CHALLENGE_TTL_MS,
    };
    if (entry.attempts >= MAX_TOTP_ATTEMPTS) return false;
    entry.attempts += 1;
    this.challengeState.set(jti, entry);
    return true;
  }

  /** Burns a challenge so its token can never be reused after a success. */
  private burnChallenge(jti: string): void {
    this.challengeState.set(jti, {
      attempts: MAX_TOTP_ATTEMPTS,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
  }

  /**
   * Password and passkey logins can be switched off instance-wide, leaving SSO
   * as the only way in. API keys are machine access and stay unaffected.
   */
  async assertLocalLoginEnabled(): Promise<void> {
    if (!(await this.settings.getLocalLoginEnabled())) {
      throw new UnauthorizedException('Local login is disabled');
    }
  }

  /**
   * Challenge tokens are signed with a key derived from — but distinct from —
   * the session secret, so a challenge token can never be replayed as a session
   * cookie (the AuthGuard verifies with the plain jwtSecret and would reject it).
   */
  private challengeSecret(): string {
    return `${loadConfig().jwtSecret}::totp-challenge`;
  }

  async login(email: string, password: string): Promise<LoginOutcome> {
    await this.assertLocalLoginEnabled();
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
        { sub: user.id, twofa: true, jti: randomUUID() } satisfies ChallengePayload,
        { secret: this.challengeSecret(), expiresIn: '5m' },
      );
      return { status: '2fa_required', challengeToken };
    }
    return { status: 'ok', ...(await this.issue(user.id, user.email, user.is_admin)) };
  }

  /** Second step of a 2FA login: validate the challenge + code, then mint a session. */
  async loginTotp(challengeToken: string, code: string): Promise<AuthResult> {
    await this.assertLocalLoginEnabled();
    let payload: ChallengePayload;
    try {
      payload = await this.jwt.verifyAsync<ChallengePayload>(challengeToken, {
        secret: this.challengeSecret(),
      });
    } catch {
      throw new UnauthorizedException('Two-factor session expired — sign in again');
    }
    if (!payload?.twofa || !payload.sub || !payload.jti) {
      throw new UnauthorizedException('Invalid two-factor session');
    }
    if (!this.consumeAttempt(payload.jti)) {
      throw new UnauthorizedException('Two-factor session expired — sign in again');
    }
    const user = await this.users.findByIdRaw(payload.sub);
    if (!user || user.disabled || !user.totp_enabled) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!(await this.totp.verifyLogin(user, code))) {
      throw new UnauthorizedException('Invalid authentication code');
    }
    // Success: burn the challenge so the same token cannot be reused.
    this.burnChallenge(payload.jti);
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
