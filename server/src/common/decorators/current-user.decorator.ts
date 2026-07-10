import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestUser, RequestAgent } from '../auth/request-user';

/** Injects the authenticated user (`req.user`). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser => {
    return ctx.switchToHttp().getRequest().user;
  },
);

/** Injects the authenticated agent (`req.agent`) for agent endpoints. */
export const CurrentAgent = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestAgent => {
    return ctx.switchToHttp().getRequest().agent;
  },
);
