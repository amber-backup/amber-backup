import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { Db, KYSELY } from '../../database/database.module';
import { CryptoService } from '../../crypto/crypto.service';
import { RequestAgent } from '../auth/request-user';

/**
 * Authenticates agent-facing endpoints via the long-lived agent credential
 * (Bearer). Only the hash is stored (agents.agent_key_hash); revocable per
 * agent. Sets `req.agent`.
 */
@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly crypto: CryptoService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing agent credential');
    }
    const token = auth.slice(7).trim();
    const hash = this.crypto.hashToken(token);
    const agent = await this.db
      .selectFrom('agents')
      .select(['id', 'name'])
      .where('agent_key_hash', '=', hash)
      .executeTakeFirst();
    if (!agent) throw new UnauthorizedException('Invalid agent credential');

    (req as Request & { agent: RequestAgent }).agent = {
      id: agent.id,
      name: agent.name,
    };
    return true;
  }
}
