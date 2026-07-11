import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Db, KYSELY } from '../database/database.module';
import {
  AuditDetails,
  AuditLog,
  AuditOutcome,
} from '../database/database.types';

/** One audit entry to persist. */
export interface AuditRecord {
  actorId?: string | null;
  actorEmail?: string | null;
  /** 'session' | 'apikey' | 'system'. */
  actorType: string;
  actorIsAdmin?: boolean;
  action: string;
  method?: string | null;
  path?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  statusCode?: number | null;
  outcome?: AuditOutcome;
  ip?: string | null;
  userAgent?: string | null;
  details?: AuditDetails | null;
}

export interface AuditListOptions {
  page?: number;
  pageSize?: number;
  search?: string;
  action?: string;
  actorId?: string;
  resourceType?: string;
  outcome?: AuditOutcome;
}

export interface AuditPage {
  items: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
}

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(KYSELY) private readonly db: Db) {}

  /**
   * Persists an audit entry. Never throws — auditing must not break the request
   * being audited; failures are logged and swallowed.
   */
  async record(entry: AuditRecord): Promise<void> {
    try {
      await this.db
        .insertInto('audit_log')
        .values({
          actor_id: entry.actorId ?? null,
          actor_email: entry.actorEmail ?? null,
          actor_type: entry.actorType,
          actor_is_admin: entry.actorIsAdmin ?? false,
          action: entry.action,
          method: entry.method ?? null,
          path: entry.path ?? null,
          resource_type: entry.resourceType ?? null,
          resource_id: entry.resourceId ?? null,
          status_code: entry.statusCode ?? null,
          outcome: entry.outcome ?? 'success',
          ip: entry.ip ?? null,
          user_agent: entry.userAgent ?? null,
          details: entry.details ? JSON.stringify(entry.details) : null,
        })
        .execute();
    } catch (err) {
      this.logger.warn(
        `Failed to write audit entry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Paginated, filtered, newest-first listing. */
  async list(opts: AuditListOptions = {}): Promise<AuditPage> {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.min(
      Math.max(Math.floor(opts.pageSize ?? DEFAULT_PAGE_SIZE), 1),
      MAX_PAGE_SIZE,
    );

    let base = this.db.selectFrom('audit_log');
    if (opts.search) {
      const like = `%${opts.search}%`;
      base = base.where((eb) =>
        eb.or([
          eb('action', 'ilike', like),
          eb('actor_email', 'ilike', like),
          eb('path', 'ilike', like),
          eb('resource_id', 'ilike', like),
        ]),
      );
    }
    if (opts.action) base = base.where('action', '=', opts.action);
    if (opts.actorId) base = base.where('actor_id', '=', opts.actorId);
    if (opts.resourceType)
      base = base.where('resource_type', '=', opts.resourceType);
    if (opts.outcome) base = base.where('outcome', '=', opts.outcome);

    const totalRow = await base
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .executeTakeFirst();
    const total = Number(totalRow?.c ?? 0);

    const items = await base
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();

    return { items, total, page, pageSize };
  }

  async get(id: string): Promise<AuditLog> {
    const row = await this.db
      .selectFrom('audit_log')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Audit entry not found');
    return row;
  }
}
