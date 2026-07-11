import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { RequestUser } from '../common/auth/request-user';
import { AuditDetails, AuditOutcome } from '../database/database.types';
import { AuditService } from './audit.service';
import { RouteMeta, clientIp, deriveAction, redactSecrets } from './audit.util';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_DETAILS_BYTES = 8192;

/**
 * Records every state-changing request (POST/PUT/PATCH/DELETE) made by an
 * authenticated user or API key into the audit log — writes and operations
 * alike (job runs, restores, deletes, settings, enrollment). Read requests and
 * the unauthenticated/agent channels are ignored. Request-body secrets are
 * redacted before storage. Auditing failures never affect the request.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { user?: RequestUser }>();

    if (!WRITE_METHODS.has(req.method) || !req.user) {
      return next.handle();
    }

    const res = ctx.switchToHttp().getResponse<Response>();
    const meta = deriveAction(
      req.method,
      req.path,
      (req.params ?? {}) as Record<string, string>,
    );

    return next.handle().pipe(
      tap({
        next: () =>
          void this.write(req, meta, 'success', res.statusCode ?? 200),
        error: (err: unknown) => {
          const status = (err as { status?: number } | null)?.status ?? 500;
          void this.write(req, meta, 'failure', status, err);
        },
      }),
    );
  }

  private async write(
    req: Request & { user?: RequestUser },
    meta: RouteMeta,
    outcome: AuditOutcome,
    statusCode: number,
    err?: unknown,
  ): Promise<void> {
    const user = req.user!;
    const details: AuditDetails = {};
    const body = redactSecrets(req.body) as Record<string, unknown> | undefined;
    if (body && typeof body === 'object' && Object.keys(body).length) {
      details.body = body;
    }
    if (req.params && Object.keys(req.params).length) {
      details.params = { ...req.params };
    }
    if (req.query && Object.keys(req.query).length) {
      details.query = { ...(req.query as Record<string, unknown>) };
    }
    if (outcome === 'failure') {
      details.error = err instanceof Error ? err.message : String(err);
    }

    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      actorType: user.authVia === 'apikey' ? 'apikey' : 'session',
      actorIsAdmin: user.isAdmin,
      action:
        user.authVia === 'apikey' ? `${meta.action} (API key)` : meta.action,
      method: req.method,
      path: (req.originalUrl || req.url).split('?')[0],
      resourceType: meta.resourceType,
      resourceId: meta.resourceId,
      statusCode,
      outcome,
      ip: clientIp(req),
      userAgent: (req.headers['user-agent'] as string) ?? null,
      details: capDetails(details),
    });
  }
}

/** Guards against storing oversized bodies in the audit row. */
function capDetails(details: AuditDetails): AuditDetails | null {
  if (Object.keys(details).length === 0) return null;
  if (JSON.stringify(details).length <= MAX_DETAILS_BYTES) return details;
  return {
    truncated: true,
    ...(details.params ? { params: details.params } : {}),
    ...(details.error ? { error: details.error } : {}),
  };
}
