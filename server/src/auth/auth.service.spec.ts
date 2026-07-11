import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { UsersService } from './users.service';

const JWT_SECRET = 'test-jwt-secret-value';

describe('AuthService (session JWT)', () => {
  let jwt: JwtService;
  let users: jest.Mocked<Pick<UsersService, 'findByEmailRaw' | 'verifyPassword' | 'findById'>>;
  let service: AuthService;

  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.JWT_EXPIRES_IN = '7d';
    jwt = new JwtService({});
    users = {
      findByEmailRaw: jest.fn(),
      verifyPassword: jest.fn(),
      findById: jest.fn(),
    } as unknown as jest.Mocked<
      Pick<UsersService, 'findByEmailRaw' | 'verifyPassword' | 'findById'>
    >;
    service = new AuthService(users as unknown as UsersService, jwt);
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

    it('issues a token on valid local credentials', async () => {
      users.findByEmailRaw.mockResolvedValue({
        id: 'u1',
        email: 'a@x.io',
        auth_source: 'local',
        disabled: false,
        is_admin: false,
      } as never);
      users.verifyPassword.mockResolvedValue(true);
      users.findById.mockResolvedValue({ id: 'u1', email: 'a@x.io' } as never);

      const { token } = await service.login('a@x.io', 'good');
      const payload = await jwt.verifyAsync<{ sub: string }>(token, {
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
  });
});
