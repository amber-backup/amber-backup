import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard } from './auth.guard';
import { CryptoService } from '../../crypto/crypto.service';
import { Db } from '../../database/database.module';
import {
  IS_ADMIN_KEY,
  ADMIN_API_KEY_KEY,
  NO_API_KEY_KEY,
  ANY_API_KEY_SCOPE_KEY,
} from '../decorators/public.decorator';
import { ApiKeyScopes } from '../../database/database.types';
import { AdminIpAllowlistService } from '../admin-ip-allowlist.service';

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
    /** Whether the admin IP allowlist admits the request. */
    ipAllowed?: boolean;
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

    const adminIps = {
      assertAllowed: jest.fn(() =>
        opts.ipAllowed === false
          ? Promise.reject(new ForbiddenException('address'))
          : Promise.resolve(),
      ),
    };
    const guard = new AuthGuard(
      reflector,
      {} as JwtService,
      crypto,
      db,
      adminIps as unknown as AdminIpAllowlistService,
    );
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: opts.method ?? 'GET',
          headers: { authorization: `Bearer ${KEY}` },
          ip: '203.0.113.9',
        }),
      }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
    return { guard, ctx, adminIps };
  }

  it('denies an API key on an admin route even for an admin user', async () => {
    const { guard, ctx } = build({ admin: true, meta: { [IS_ADMIN_KEY]: true } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a read-only admin key to read an AllowAdminApiKey route', async () => {
    const { guard, ctx } = build({
      admin: true,
      scopes: { actions: ['read'] },
      meta: { [IS_ADMIN_KEY]: true, [ADMIN_API_KEY_KEY]: true },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows a full-access admin key to mutate on an AllowAdminApiKey route', async () => {
    const { guard, ctx } = build({
      method: 'POST',
      admin: true,
      meta: { [IS_ADMIN_KEY]: true, [ADMIN_API_KEY_KEY]: true },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('denies a scoped admin key a mutation on an AllowAdminApiKey route', async () => {
    const { guard, ctx } = build({
      method: 'POST',
      admin: true,
      scopes: { actions: ['operate'] },
      meta: { [IS_ADMIN_KEY]: true, [ADMIN_API_KEY_KEY]: true },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies a non-admin key on an AllowAdminApiKey route', async () => {
    const { guard, ctx } = build({
      meta: { [IS_ADMIN_KEY]: true, [ADMIN_API_KEY_KEY]: true },
    });
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

  it('denies an admin outside the admin IP allowlist on any route', async () => {
    const { guard, ctx, adminIps } = build({ admin: true, ipAllowed: false });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(adminIps.assertAllowed).toHaveBeenCalledWith('203.0.113.9', 'u@x');
  });

  it('does not apply the admin IP allowlist to non-admins', async () => {
    const { guard, ctx, adminIps } = build({ ipAllowed: false });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(adminIps.assertAllowed).not.toHaveBeenCalled();
  });
});
