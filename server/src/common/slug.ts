import { Kysely } from 'kysely';
import { Database } from '../database/database.types';

/** Tables whose rows carry a name-derived slug (see migration `012_slugs`). */
export type SlugTable =
  | 'targets'
  | 'repositories'
  | 'agents'
  | 'backup_jobs'
  | 'notification_channels'
  | 'reports';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `s` is a canonical UUID (the only shape the `id` columns accept). */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * Derives the slug base from a display name: lowercase kebab-case. Every run of
 * non-ASCII-alphanumeric characters becomes one dash; a name with no usable
 * characters at all falls back to 'entity'.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'entity';
}

/**
 * Picks a slug for `name` that is free in `table`, appending `-2`, `-3`, … on
 * collisions. `excludeId` keeps one row (typically the row being renamed) out
 * of the collision check, so re-saving an unchanged name keeps its slug. The
 * per-table unique index is the backstop for concurrent writes.
 */
export async function uniqueSlug(
  db: Kysely<Database>,
  table: SlugTable,
  name: string,
  excludeId?: string,
): Promise<string> {
  const base = slugify(name);
  // The cast pins the query to one member of the union so column references
  // resolve; every SlugTable shares the `id` and `slug` columns used here.
  let q = db
    .selectFrom(table as 'targets')
    .select('slug')
    .where((eb) =>
      eb.or([eb('slug', '=', base), eb('slug', 'like', `${base}-%`)]),
    );
  if (excludeId) q = q.where('id', '!=', excludeId);
  const rows = await q.execute();

  const suffixRe = new RegExp(`^${base}-(\\d+)$`);
  let baseTaken = false;
  let maxSuffix = 1;
  for (const { slug } of rows) {
    if (slug === base) {
      baseTaken = true;
      continue;
    }
    const m = suffixRe.exec(slug);
    if (m) maxSuffix = Math.max(maxSuffix, Number(m[1]));
  }
  return baseTaken ? `${base}-${maxSuffix + 1}` : base;
}
