import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Db, KYSELY } from '../database/database.module';
import { AccessLevel, ResourceType } from '../database/database.types';
import { RequestUser } from './auth/request-user';

const LEVEL_RANK: Record<AccessLevel, number> = {
  view: 1,
  operate: 2,
  manage: 3,
};

/**
 * Central RBAC enforcement (§11). Admins bypass all checks. Non-admins need a
 * matching resource_grant. API-key requests are additionally bounded by scopes.
 */
@Injectable()
export class AccessControlService {
  constructor(@Inject(KYSELY) private readonly db: Db) {}

  /** Returns whether the user may access a resource at the given level. */
  async can(
    user: RequestUser,
    type: ResourceType,
    resourceId: string,
    level: AccessLevel,
  ): Promise<boolean> {
    if (!this.apiKeyAllows(user, type, resourceId, level)) return false;
    if (user.isAdmin) return true;

    const grant = await this.db
      .selectFrom('resource_grants')
      .select('access_level')
      .where('user_id', '=', user.id)
      .where('resource_type', '=', type)
      .where('resource_id', '=', resourceId)
      .executeTakeFirst();

    if (!grant) return false;
    return LEVEL_RANK[grant.access_level] >= LEVEL_RANK[level];
  }

  /** Throws ForbiddenException when access is denied. */
  async assert(
    user: RequestUser,
    type: ResourceType,
    resourceId: string,
    level: AccessLevel,
  ): Promise<void> {
    if (!(await this.can(user, type, resourceId, level))) {
      throw new ForbiddenException(
        `Missing '${level}' access on ${type} ${resourceId}`,
      );
    }
  }

  /** IDs of resources of a type the user may at least view (for list filtering). */
  async visibleResourceIds(
    user: RequestUser,
    type: ResourceType,
  ): Promise<string[] | 'all'> {
    // API-key resource scope, if any, is an upper bound on visibility.
    const scoped = user.apiKeyScopes?.resources
      ?.filter((r) => r.type === type)
      .map((r) => r.id);

    if (user.isAdmin) {
      return scoped ?? 'all';
    }

    const rows = await this.db
      .selectFrom('resource_grants')
      .select('resource_id')
      .where('user_id', '=', user.id)
      .where('resource_type', '=', type)
      .execute();
    let ids = rows.map((r) => r.resource_id);
    if (scoped) ids = ids.filter((id) => scoped.includes(id));
    return ids;
  }

  /** Checks the API-key action + resource scope (independent of grants). */
  private apiKeyAllows(
    user: RequestUser,
    type: ResourceType,
    resourceId: string,
    level: AccessLevel,
  ): boolean {
    const scopes = user.apiKeyScopes;
    if (!scopes) return true; // session auth is not scope-limited

    const action = this.levelToAction(level);
    const actions = scopes.actions ?? [];
    if (!actions.includes('*') && !actions.includes(action)) return false;

    if (scopes.resources) {
      const ok = scopes.resources.some(
        (r) => r.type === type && r.id === resourceId,
      );
      if (!ok) return false;
    }
    return true;
  }

  private levelToAction(level: AccessLevel): string {
    switch (level) {
      case 'view':
        return 'read';
      case 'operate':
        return 'operate';
      case 'manage':
        return 'manage';
    }
  }
}
