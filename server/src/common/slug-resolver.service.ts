import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Db, KYSELY } from '../database/database.module';
import { isUuid, SlugTable } from './slug';

/**
 * Translates a route's `:id` parameter into a canonical row id. Every named
 * entity carries a unique, name-derived slug (see `common/slug.ts`), so the
 * API — and thus the CLI — accepts either the UUID or the slug wherever a
 * single entity is addressed. Resolution happens before any ACL check because
 * grants are stored against UUIDs.
 */
@Injectable()
export class SlugResolverService {
  constructor(@Inject(KYSELY) private readonly db: Db) {}

  async resolve(table: SlugTable, idOrSlug: string): Promise<string> {
    if (isUuid(idOrSlug)) return idOrSlug;
    // The cast pins the query to one member of the union so column references
    // resolve; every SlugTable shares the `id` and `slug` columns used here.
    const row = await this.db
      .selectFrom(table as 'targets')
      .select('id')
      .where('slug', '=', idOrSlug)
      .executeTakeFirst();
    if (!row) throw new NotFoundException(`No entity with slug '${idOrSlug}'`);
    return row.id;
  }
}
