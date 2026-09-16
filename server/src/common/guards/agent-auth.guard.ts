import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { Db, KYSELY } from '../../database/database.module';
import { CryptoService } from '../../crypto/crypto.service';
import { RequestAgent } from '../auth/request-user';
import { ipAllowed, normalizeIp } from '../ip-allowlist';

/**
 * Authenticates agent-facing endpoints via the long-lived agent credential
 * (Bearer). Only the hash is stored (agents.agent_key_hash); revocable per
 * agent. Requests from outside the agent's IP allowlist (when set) are
 * rejected even with a valid credential. Sets `req.agent`.
 */
@Injectable()
export class AgentAuthGuard implements CanActivate {
  private readonly logger = new Logger(AgentAuthGuard.name);

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
      .select(['id', 'name', 'allowed_ips'])
      .where('agent_key_hash', '=', hash)
      .executeTakeFirst();
    if (!agent) throw new UnauthorizedException('Invalid agent credential');

    // req.ip honours X-Forwarded-For only per the `trust proxy` setting.
    const ip = req.ip ? normalizeIp(req.ip) : undefined;
    if (!ipAllowed(agent.allowed_ips ?? [], ip)) {
      this.logger.warn(
        `Agent "${agent.name}" (${agent.id}) rejected: ${ip ?? 'unknown address'} is not in its IP allowlist`,
      );
      throw new ForbiddenException('Request address not allowed for this agent');
    }

    (req as Request & { agent: RequestAgent }).agent = {
      id: agent.id,
      name: agent.name,
      ip,
    };
    return true;
  }
}
