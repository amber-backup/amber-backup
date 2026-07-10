import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { loadConfig } from '../config/configuration';
import { PublicUser, UsersService } from './users.service';

export interface AuthResult {
  token: string;
  user: PublicUser;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.users.findByEmailRaw(email);
    if (!user || user.auth_source !== 'local') {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.disabled) throw new UnauthorizedException('Account disabled');
    if (!(await this.users.verifyPassword(user, password))) {
      throw new UnauthorizedException('Invalid credentials');
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
