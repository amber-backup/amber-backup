import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { Db, KYSELY } from '../../database/database.module';
import { CryptoService } from '../../crypto/crypto.service';
import {
  IS_PUBLIC_KEY,
  IS_ADMIN_KEY,
  REQUIRED_ACTION_KEY,
} from '../decorators/public.decorator';
import { RequestUser } from '../auth/request-user';

export const SESSION_COOKIE = 'amber_session';
export const API_KEY_PREFIX = 'ak_';

interface JwtPayload {
  sub: string;
  email: string;
  isAdmin: boolean;
}

/**
 * Unified authentication for user-facing endpoints. Accepts a session JWT
 * (cookie or Bearer) or an API key. Enforces @Public / @RequireAdmin /
 * @RequireAction metadata.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
    @Inject(KYSELY) private readonly db: Db,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedException('Missing credentials');

    const user = token.startsWith(API_KEY_PREFIX)
      ? await this.fromApiKey(token)
      : await this.fromJwt(token);

    (req as Request & { user: RequestUser }).user = user;

    // Route-level admin requirement.
    const requireAdmin = this.reflector.getAllAndOverride<boolean>(
      IS_ADMIN_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (requireAdmin && !user.isAdmin) {
      throw new ForbiddenException('Administrator access required');
    }

    // API-key action scope requirement.
    const requiredAction = this.reflector.getAllAndOverride<string>(
      REQUIRED_ACTION_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (requiredAction && user.apiKeyScopes) {
      const actions = user.apiKeyScopes.actions ?? [];
      if (!actions.includes('*') && !actions.includes(requiredAction)) {
        throw new ForbiddenException(`API key lacks '${requiredAction}' scope`);
      }
    }

    return true;
  }

  private extractToken(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
    const cookie = (req as Request & { cookies?: Record<string, string> })
      .cookies?.[SESSION_COOKIE];
    return cookie;
  }

  private async fromJwt(token: string): Promise<RequestUser> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }
    const user = await this.db
      .selectFrom('users')
      .select(['id', 'email', 'is_admin', 'disabled'])
      .where('id', '=', payload.sub)
      .executeTakeFirst();
    if (!user || user.disabled) {
      throw new UnauthorizedException('Account disabled or missing');
    }
    return {
      id: user.id,
      email: user.email,
      isAdmin: user.is_admin,
      authVia: 'session',
    };
  }

  private async fromApiKey(token: string): Promise<RequestUser> {
    const hash = this.crypto.hashToken(token);
    const key = await this.db
      .selectFrom('api_keys')
      .innerJoin('users', 'users.id', 'api_keys.user_id')
      .select([
        'api_keys.id as key_id',
        'api_keys.scopes',
        'api_keys.expires_at',
        'users.id as user_id',
        'users.email',
        'users.is_admin',
        'users.disabled',
      ])
      .where('api_keys.key_hash', '=', hash)
      .executeTakeFirst();

    if (!key) throw new UnauthorizedException('Invalid API key');
    if (key.expires_at && new Date(key.expires_at) < new Date()) {
      throw new UnauthorizedException('API key expired');
    }
    if (key.disabled) throw new UnauthorizedException('Account disabled');

    // Fire-and-forget last-used update.
    void this.db
      .updateTable('api_keys')
      .set({ last_used_at: new Date() })
      .where('id', '=', key.key_id)
      .execute()
      .catch(() => undefined);

    return {
      id: key.user_id,
      email: key.email,
      isAdmin: key.is_admin,
      authVia: 'apikey',
      apiKeyId: key.key_id,
      apiKeyScopes:
        typeof key.scopes === 'string' ? JSON.parse(key.scopes) : key.scopes,
    };
  }
}
