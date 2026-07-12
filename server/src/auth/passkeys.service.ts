import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { Db, KYSELY } from '../database/database.module';
import { loadConfig } from '../config/configuration';

const RP_NAME = 'Amber Backup';

/** Non-secret summary of a registered passkey for the settings UI. */
export interface PublicPasskey {
  id: string;
  name: string;
  device_type: string | null;
  backed_up: boolean;
  created_at: Date;
  last_used_at: Date | null;
}

interface RegChallenge {
  sub: string;
  challenge: string;
  kind: 'reg';
}
interface AuthChallenge {
  challenge: string;
  kind: 'auth';
}

/**
 * WebAuthn / passkey authentication. Public keys are stored in the clear (safe
 * by design); the per-ceremony challenge is round-tripped in a short-lived
 * signed cookie rather than server state. Login uses discoverable credentials
 * (usernameless): the authenticator identifies the account, so no email is
 * needed up front.
 */
@Injectable()
export class PasskeysService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly jwt: JwtService,
  ) {}

  private rpID(): string {
    return loadConfig().webauthnRpId;
  }
  private origins(): string[] {
    return loadConfig().webauthnOrigins;
  }
  // Signed with a key derived from — but distinct from — the session secret, so
  // a challenge cookie can never double as a session (mirrors the TOTP flow).
  private challengeSecret(): string {
    return `${loadConfig().jwtSecret}::webauthn`;
  }

  private signChallenge(payload: RegChallenge | AuthChallenge): Promise<string> {
    return this.jwt.signAsync(payload, {
      secret: this.challengeSecret(),
      expiresIn: '5m',
    });
  }

  private async readChallenge<T extends RegChallenge | AuthChallenge>(
    token: string | undefined,
  ): Promise<T> {
    if (!token) throw new BadRequestException('Missing WebAuthn challenge');
    try {
      return await this.jwt.verifyAsync<T>(token, {
        secret: this.challengeSecret(),
      });
    } catch {
      throw new BadRequestException('WebAuthn challenge expired — try again');
    }
  }

  private parseTransports(value: unknown): AuthenticatorTransportFuture[] {
    const arr =
      typeof value === 'string' ? JSON.parse(value) : (value ?? []);
    return arr as AuthenticatorTransportFuture[];
  }

  // --- Registration (authenticated user) ------------------------------------

  async registrationOptions(
    userId: string,
    email: string,
  ): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeToken: string }> {
    const existing = await this.db
      .selectFrom('webauthn_credentials')
      .select(['credential_id', 'transports'])
      .where('user_id', '=', userId)
      .execute();

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: this.rpID(),
      userName: email,
      userDisplayName: email,
      // The user handle is our stable user id, so discoverable credentials map
      // straight back to the account.
      userID: new TextEncoder().encode(userId),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.credential_id,
        transports: this.parseTransports(c.transports),
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    const challengeToken = await this.signChallenge({
      sub: userId,
      challenge: options.challenge,
      kind: 'reg',
    });
    return { options, challengeToken };
  }

  async verifyRegistration(
    userId: string,
    challengeToken: string | undefined,
    response: RegistrationResponseJSON,
    name: string | undefined,
  ): Promise<PublicPasskey> {
    const payload = await this.readChallenge<RegChallenge>(challengeToken);
    if (payload.kind !== 'reg' || payload.sub !== userId) {
      throw new BadRequestException('Invalid WebAuthn challenge');
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: payload.challenge,
        expectedOrigin: this.origins(),
        expectedRPID: this.rpID(),
      });
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'Passkey verification failed',
      );
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException('Passkey registration could not be verified');
    }

    const { credential, credentialDeviceType, credentialBackedUp } =
      verification.registrationInfo;
    const row = await this.db
      .insertInto('webauthn_credentials')
      .values({
        user_id: userId,
        credential_id: credential.id,
        public_key: Buffer.from(credential.publicKey).toString('base64'),
        counter: credential.counter,
        transports: JSON.stringify(credential.transports ?? []),
        device_type: credentialDeviceType,
        backed_up: credentialBackedUp,
        name: (name?.trim() || 'Passkey').slice(0, 64),
      })
      .returning([
        'id',
        'name',
        'device_type',
        'backed_up',
        'created_at',
        'last_used_at',
      ])
      .executeTakeFirstOrThrow();
    return row;
  }

  // --- Authentication (login, unauthenticated) ------------------------------

  async authenticationOptions(): Promise<{
    options: PublicKeyCredentialRequestOptionsJSON;
    challengeToken: string;
  }> {
    const options = await generateAuthenticationOptions({
      rpID: this.rpID(),
      userVerification: 'preferred',
      // No allowCredentials → usernameless / discoverable-credential login.
    });
    const challengeToken = await this.signChallenge({
      challenge: options.challenge,
      kind: 'auth',
    });
    return { options, challengeToken };
  }

  async verifyAuthentication(
    challengeToken: string | undefined,
    response: AuthenticationResponseJSON,
  ): Promise<{ userId: string }> {
    const payload = await this.readChallenge<AuthChallenge>(challengeToken);
    if (payload.kind !== 'auth') {
      throw new BadRequestException('Invalid WebAuthn challenge');
    }

    const cred = await this.db
      .selectFrom('webauthn_credentials')
      .selectAll()
      .where('credential_id', '=', response.id)
      .executeTakeFirst();
    if (!cred) throw new UnauthorizedException('Unrecognized passkey');

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: payload.challenge,
        expectedOrigin: this.origins(),
        expectedRPID: this.rpID(),
        credential: {
          id: cred.credential_id,
          publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64')),
          counter: Number(cred.counter),
          transports: this.parseTransports(cred.transports),
        },
      });
    } catch (e) {
      throw new UnauthorizedException(
        e instanceof Error ? e.message : 'Passkey verification failed',
      );
    }
    if (!verification.verified) {
      throw new UnauthorizedException('Passkey verification failed');
    }

    await this.db
      .updateTable('webauthn_credentials')
      .set({
        counter: verification.authenticationInfo.newCounter,
        last_used_at: new Date(),
      })
      .where('id', '=', cred.id)
      .execute();

    return { userId: cred.user_id };
  }

  // --- Management -----------------------------------------------------------

  async list(userId: string): Promise<PublicPasskey[]> {
    return this.db
      .selectFrom('webauthn_credentials')
      .select([
        'id',
        'name',
        'device_type',
        'backed_up',
        'created_at',
        'last_used_at',
      ])
      .where('user_id', '=', userId)
      .orderBy('created_at', 'asc')
      .execute();
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.db
      .deleteFrom('webauthn_credentials')
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .execute();
  }
}
