import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { UsersService } from './users.service';
import { TotpService } from './totp.service';

// Stub the TOTP module so the test doesn't pull in otplib's ESM (which Jest
// doesn't transform under node_modules). The service is mocked per-test anyway.
jest.mock('./totp.service', () => ({ TotpService: class TotpService {} }));

const JWT_SECRET = 'test-jwt-secret-value';

describe('AuthService (session JWT)', () => {
  let jwt: JwtService;
  let users: jest.Mocked<
    Pick<UsersService, 'findByEmailRaw' | 'verifyPassword' | 'findById' | 'findByIdRaw'>
  >;
  let totp: jest.Mocked<Pick<TotpService, 'verifyLogin'>>;
  let service: AuthService;

  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.JWT_EXPIRES_IN = '7d';
    jwt = new JwtService({});
    users = {
      findByEmailRaw: jest.fn(),
      verifyPassword: jest.fn(),
      findById: jest.fn(),
      findByIdRaw: jest.fn(),
    } as unknown as jest.Mocked<
      Pick<UsersService, 'findByEmailRaw' | 'verifyPassword' | 'findById' | 'findByIdRaw'>
    >;
    totp = { verifyLogin: jest.fn() } as unknown as jest.Mocked<
      Pick<TotpService, 'verifyLogin'>
    >;
    service = new AuthService(
      users as unknown as UsersService,
      jwt,
      totp as unknown as TotpService,
    );
  });

  describe('issue', () => {
    it('signs a JWT carrying the user identity, verifiable with the configured secret', async () => {
      users.findById.mockResolvedValue({ id: 'u1', email: 'a@x.io' } as never);

      const { token, user } = await service.issue('u1', 'a@x.io', true);

      const payload = await jwt.verifyAsync<{
        sub: string;
        email: string;
        isAdmin: boolean;
      }>(token, { secret: JWT_SECRET });
      expect(payload.sub).toBe('u1');
      expect(payload.email).toBe('a@x.io');
      expect(payload.isAdmin).toBe(true);
      expect(user).toEqual({ id: 'u1', email: 'a@x.io' });
    });

    it('produces a token that fails verification under a different secret', async () => {
      users.findById.mockResolvedValue({ id: 'u1' } as never);
      const { token } = await service.issue('u1', 'a@x.io', false);
      await expect(
        jwt.verifyAsync(token, { secret: 'wrong-secret' }),
      ).rejects.toBeDefined();
    });
  });

  describe('login', () => {
    it('rejects when the password does not verify', async () => {
      users.findByEmailRaw.mockResolvedValue({
        id: 'u1',
        email: 'a@x.io',
        auth_source: 'local',
        disabled: false,
      } as never);
      users.verifyPassword.mockResolvedValue(false);

      await expect(service.login('a@x.io', 'bad')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('issues a session on valid local credentials without 2FA', async () => {
      users.findByEmailRaw.mockResolvedValue({
        id: 'u1',
        email: 'a@x.io',
        auth_source: 'local',
        disabled: false,
        is_admin: false,
        totp_enabled: false,
      } as never);
      users.verifyPassword.mockResolvedValue(true);
      users.findById.mockResolvedValue({ id: 'u1', email: 'a@x.io' } as never);

      const result = await service.login('a@x.io', 'good');
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('expected ok outcome');
      const payload = await jwt.verifyAsync<{ sub: string }>(result.token, {
        secret: JWT_SECRET,
      });
      expect(payload.sub).toBe('u1');
    });

    it('refuses to verify passwords for SSO accounts', async () => {
      users.findByEmailRaw.mockResolvedValue({
        id: 'u1',
        auth_source: 'oidc',
        disabled: false,
      } as never);

      await expect(service.login('a@x.io', 'x')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(users.verifyPassword).not.toHaveBeenCalled();
    });

    it('returns a 2FA challenge (and no session) when TOTP is enabled', async () => {
      users.findByEmailRaw.mockResolvedValue({
        id: 'u1',
        email: 'a@x.io',
        auth_source: 'local',
        disabled: false,
        is_admin: false,
        totp_enabled: true,
      } as never);
      users.verifyPassword.mockResolvedValue(true);

      const result = await service.login('a@x.io', 'good');
      expect(result.status).toBe('2fa_required');
      if (result.status !== '2fa_required') throw new Error('expected challenge');
      // The challenge token must NOT be usable as a session (verified with the
      // plain session secret by the AuthGuard).
      await expect(
        jwt.verifyAsync(result.challengeToken, { secret: JWT_SECRET }),
      ).rejects.toBeDefined();
    });
  });

  describe('loginTotp', () => {
    it('issues a session when the code verifies against a valid challenge', async () => {
      // Obtain a real challenge token via the login step.
      users.findByEmailRaw.mockResolvedValue({
        id: 'u1',
        email: 'a@x.io',
        auth_source: 'local',
        disabled: false,
        is_admin: false,
        totp_enabled: true,
      } as never);
      users.verifyPassword.mockResolvedValue(true);
      const challenge = await service.login('a@x.io', 'good');
      if (challenge.status !== '2fa_required') throw new Error('expected challenge');

      users.findByIdRaw.mockResolvedValue({
        id: 'u1',
        email: 'a@x.io',
        disabled: false,
        totp_enabled: true,
      } as never);
      users.findById.mockResolvedValue({ id: 'u1', email: 'a@x.io' } as never);
      totp.verifyLogin.mockResolvedValue(true);

      const result = await service.loginTotp(challenge.challengeToken, '123456');
      const payload = await jwt.verifyAsync<{ sub: string }>(result.token, {
        secret: JWT_SECRET,
      });
      expect(payload.sub).toBe('u1');
    });

    it('rejects an invalid code', async () => {
      users.findByEmailRaw.mockResolvedValue({
        id: 'u1',
        email: 'a@x.io',
        auth_source: 'local',
        disabled: false,
        is_admin: false,
        totp_enabled: true,
      } as never);
      users.verifyPassword.mockResolvedValue(true);
      const challenge = await service.login('a@x.io', 'good');
      if (challenge.status !== '2fa_required') throw new Error('expected challenge');

      users.findByIdRaw.mockResolvedValue({
        id: 'u1',
        disabled: false,
        totp_enabled: true,
      } as never);
      totp.verifyLogin.mockResolvedValue(false);

      await expect(
        service.loginTotp(challenge.challengeToken, '000000'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a forged/expired challenge token', async () => {
      await expect(
        service.loginTotp('not-a-valid-token', '123456'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
