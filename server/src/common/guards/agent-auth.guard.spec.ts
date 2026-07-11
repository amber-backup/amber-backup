import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { chain, createDbMock, TEST_MASTER_KEY } from '../../testing/db-mock';

process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;

import { CryptoService } from '../../crypto/crypto.service';
import { AgentAuthGuard } from './agent-auth.guard';

function contextWithAuth(authorization?: string): ExecutionContext {
  const req = { headers: authorization ? { authorization } : {}, agent: undefined };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext & { __req: typeof req };
}

describe('AgentAuthGuard (bearer credential hashing)', () => {
  let crypto: CryptoService;

  beforeEach(() => {
    process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;
    crypto = new CryptoService();
  });

  it('looks the agent up by the SHA-256 hash of the bearer token', async () => {
    const select = chain({ executeTakeFirst: { id: 'agent-1', name: 'web-1' } });
    const { db } = createDbMock({ selectFrom: select });
    const guard = new AgentAuthGuard(db, crypto);

    const req = { headers: { authorization: 'Bearer raw-agent-key' } } as Record<
      string,
      unknown
    >;
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // Never queried by the plaintext credential.
    expect(select.where.mock.calls[0]).toEqual([
      'agent_key_hash',
      '=',
      crypto.hashToken('raw-agent-key'),
    ]);
    expect(req.agent).toEqual({ id: 'agent-1', name: 'web-1' });
  });

  it('rejects a request without a bearer token', async () => {
    const { db } = createDbMock({});
    const guard = new AgentAuthGuard(db, crypto);
    await expect(guard.canActivate(contextWithAuth())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an unknown credential', async () => {
    const select = chain({ executeTakeFirst: undefined });
    const { db } = createDbMock({ selectFrom: select });
    const guard = new AgentAuthGuard(db, crypto);
    await expect(
      guard.canActivate(contextWithAuth('Bearer nope')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
