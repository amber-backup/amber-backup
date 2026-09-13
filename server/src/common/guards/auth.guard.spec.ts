import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard } from './auth.guard';
import { CryptoService } from '../../crypto/crypto.service';
import { Db } from '../../database/database.module';
import {
  IS_ADMIN_KEY,
  NO_API_KEY_KEY,
  ANY_API_KEY_SCOPE_KEY,
} from '../decorators/public.decorator';
import { ApiKeyScopes } from '../../database/database.types';

/**
 * These tests exercise the metadata rules for API-key callers. The key lookup
 * is stubbed so canActivate resolves an api-key principal, then the route
 * metadata (RequireAdmin / NoApiKey / scope) decides the outcome.
 */
describe('AuthGuard — API key restrictions', () => {
  const KEY = 'ak_test';

  function build(opts: {
    method?: string;
    admin?: boolean;
    scopes?: ApiKeyScopes;
    meta?: Record<string, boolean>;
  }) {
    const meta = opts.meta ?? {};
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => meta[key]),
    } as unknown as Reflector;
    const crypto = { hashToken: () => 'hash' } as unknown as CryptoService;
    const db = {
      selectFrom: () => ({
        innerJoin: () => ({
          select: () => ({
            where: () => ({
              executeTakeFirst: () =>
                Promise.resolve({
                  key_id: 'k1',
                  scopes: opts.scopes ?? { actions: ['*'] },
                  expires_at: null,
                  user_id: 'u1',
                  email: 'u@x',
                  is_admin: opts.admin ?? false,
                  disabled: false,
                }),
            }),
          }),
        }),
      }),
      updateTable: () => ({
        set: () => ({ where: () => ({ execute: () => Promise.resolve() }) }),
      }),
    } as unknown as Db;

    const guard = new AuthGuard(reflector, {} as JwtService, crypto, db);
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: opts.method ?? 'GET',
          headers: { authorization: `Bearer ${KEY}` },
        }),
      }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
    return { guard, ctx };
  }

  it('denies an API key on an admin route even for an admin user', async () => {
    const { guard, ctx } = build({ admin: true, meta: { [IS_ADMIN_KEY]: true } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies an API key on a NoApiKey route', async () => {
    const { guard, ctx } = build({ meta: { [NO_API_KEY_KEY]: true } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies a read-only key on a mutating request', async () => {
    const { guard, ctx } = build({ method: 'POST', scopes: { actions: ['read'] } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a read-only key on a mutating route marked AnyApiKeyScope', async () => {
    const { guard, ctx } = build({
      method: 'DELETE',
      scopes: { actions: ['read'] },
      meta: { [ANY_API_KEY_SCOPE_KEY]: true },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows a read-only key on a GET', async () => {
    const { guard, ctx } = build({ method: 'GET', scopes: { actions: ['read'] } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows an operate-scoped key on a mutating request (resource ACL still applies)', async () => {
    const { guard, ctx } = build({ method: 'POST', scopes: { actions: ['operate'] } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
