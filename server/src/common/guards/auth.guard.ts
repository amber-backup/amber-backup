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
  NO_API_KEY_KEY,
} from '../decorators/public.decorator';
import { RequestUser } from '../auth/request-user';

export const SESSION_COOKIE = 'amber_session';
export const API_KEY_PREFIX = 'ak_';

interface JwtPayload {
  sub: string;
  email: string;
  isAdmin: boolean;
  /** Session generation the token was minted at (see users.session_epoch). */
  se?: number;
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
    if (requireAdmin) {
      // API keys never exercise administrator privileges, even for an admin
      // user: an admin's leaked read-scoped key must not manage users, settings
      // or agents. Admin operations require an interactive session.
      if (user.authVia === 'apikey') {
        throw new ForbiddenException(
          'Administrator operations require an interactive session, not an API key',
        );
      }
      if (!user.isAdmin) {
        throw new ForbiddenException('Administrator access required');
      }
    }

    // Routes explicitly closed to API keys (e.g. API-key management, so a key
    // can never mint or revoke another key).
    const noApiKey = this.reflector.getAllAndOverride<boolean>(NO_API_KEY_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (noApiKey && user.authVia === 'apikey') {
      throw new ForbiddenException('This operation is not permitted for API keys');
    }

    // Coarse action-scope enforcement for API keys: a scoped key (actions
    // without '*') may only perform a state-changing request if it carries an
    // action beyond 'read'. Fine-grained per-resource action/level checks still
    // run in AccessControlService for resource routes.
    if (user.apiKeyScopes) {
      const actions = user.apiKeyScopes.actions ?? [];
      const unrestricted = actions.includes('*');
      const method = req.method.toUpperCase();
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
      if (!unrestricted && mutating && !actions.some((a) => a !== 'read')) {
        throw new ForbiddenException('API key lacks a write scope');
      }
    }

    // API-key action scope requirement declared per route.
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
      .select(['id', 'email', 'is_admin', 'disabled', 'session_epoch'])
      .where('id', '=', payload.sub)
      .executeTakeFirst();
    if (!user || user.disabled) {
      throw new UnauthorizedException('Account disabled or missing');
    }
    // Reject tokens minted before the user's current session generation (e.g.
    // after a password change). Tokens issued before this field existed carry
    // no `se` and are accepted until they expire.
    if (typeof payload.se === 'number' && payload.se !== user.session_epoch) {
      throw new UnauthorizedException('Session expired — sign in again');
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
