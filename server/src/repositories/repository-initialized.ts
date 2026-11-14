import { Db } from '../database/database.module';

/**
 * The query behind `repositoryKnownInitialized` (exported for tests): finds
 * the repository when anything shows it existed at its current location.
 * Evidence older than `relocated_at` (the job was pointed at another
 * connection or path) belongs to the previous location and does not count.
 */
export function knownInitializedQuery(db: Db, repositoryId: string) {
  return db
    .selectFrom('repositories as r')
    .select('r.id')
    .where('r.id', '=', repositoryId)
    .where((eb) => {
      const notRelocated = eb('r.relocated_at', 'is', null);
      const sinceRelocation = (column: 'r.stats_at' | 'r.check_at') =>
        eb.and([
          eb(column, 'is not', null),
          eb.or([notRelocated, eb(column, '>', eb.ref('r.relocated_at'))]),
        ]);
      return eb.or([
        // Reset on relocation; set when Amber initialised / found the repo.
        eb('r.initialized_at', 'is not', null),
        sinceRelocation('r.stats_at'),
        sinceRelocation('r.check_at'),
        eb.and([eb('r.snapshot_count', '>', 0), notRelocated]),
        eb.exists(
          eb
            .selectFrom('job_runs as jr')
            .innerJoin('backup_jobs as bj', 'bj.id', 'jr.job_id')
            .select('jr.id')
            .whereRef('bj.repository_id', '=', 'r.id')
            .where('jr.kind', '=', 'backup')
            .where('jr.status', '=', 'success')
            .where((sub) =>
              sub.or([
                sub('r.relocated_at', 'is', null),
                sub('jr.started_at', '>', sub.ref('r.relocated_at')),
              ]),
            ),
        ),
        eb.exists(
          eb
            .selectFrom('proxmox_job_guests as g')
            .innerJoin('backup_jobs as bj', 'bj.id', 'g.job_id')
            .select('g.job_id')
            .whereRef('bj.repository_id', '=', 'r.id')
            .where('g.last_snapshot_id', 'is not', null)
            .where((sub) =>
              sub.or([
                sub('r.relocated_at', 'is', null),
                sub.and([
                  sub('g.last_status', '=', 'success'),
                  sub('g.last_finished_at', '>', sub.ref('r.relocated_at')),
                ]),
              ]),
            ),
        ),
      ]);
    });
}

/**
 * Whether the server knows that this repository already existed at its
 * current location: Amber initialised it or found it in place
 * (`initialized_at`), read its figures or integrity, or a backup into it
 * succeeded. Sent to agents as `AgentTask.repoInitialized` and used by local
 * runs: a repository that is known to have existed and is now missing is never
 * re-created by `restic init` — that is almost always an unmounted or
 * unreachable target.
 */
export async function repositoryKnownInitialized(
  db: Db,
  repositoryId: string,
): Promise<boolean> {
  const row = await knownInitializedQuery(db, repositoryId).executeTakeFirst();
  return !!row;
}

/** Records that the repository exists (first time only). */
export async function markRepositoryInitialized(
  db: Db,
  repositoryId: string,
): Promise<void> {
  await db
    .updateTable('repositories')
    .set({ initialized_at: new Date() })
    .where('id', '=', repositoryId)
    .where('initialized_at', 'is', null)
    .execute();
}

/**
 * Repository columns to write when a job points its repository at another
 * location: what was known about the old location no longer applies, so the
 * new one may be initialised once (see `knownInitializedQuery`).
 */
export function relocationPatch(now = new Date()): {
  initialized_at: null;
  relocated_at: Date;
} {
  return { initialized_at: null, relocated_at: now };
}
