import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { Database } from '../database/database.types';
import { chain, createDbMock } from '../testing/db-mock';
import {
  knownInitializedQuery,
  markRepositoryInitialized,
  relocationPatch,
  repositoryKnownInitialized,
} from './repository-initialized';

/** A Kysely that compiles Postgres SQL without a connection. */
const compiler = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const squash = (s: string) => s.replace(/\s+/g, ' ');

describe('repositoryKnownInitialized', () => {
  it('looks for evidence of the repository at its current location', () => {
    const { sql, parameters } = knownInitializedQuery(compiler, 'repo-1').compile();
    const text = squash(sql);

    expect(parameters).toContain('repo-1');
    expect(text).toContain('"r"."initialized_at" is not null');
    // Figures, integrity checks, backups and Proxmox snapshots count only
    // when they are newer than the last relocation.
    expect(text).toContain(
      '("r"."stats_at" is not null and ("r"."relocated_at" is null or "r"."stats_at" > "r"."relocated_at"))',
    );
    expect(text).toContain(
      '("r"."check_at" is not null and ("r"."relocated_at" is null or "r"."check_at" > "r"."relocated_at"))',
    );
    expect(text).toContain('("r"."snapshot_count" > $');
    expect(text).toContain('from "job_runs" as "jr"');
    expect(text).toContain('"jr"."started_at" > "r"."relocated_at"');
    expect(text).toContain('from "proxmox_job_guests" as "g"');
    expect(text).toContain('"g"."last_finished_at" > "r"."relocated_at"');
  });

  it('is true when the query finds the repository', async () => {
    const { db } = createDbMock({
      selectFrom: chain({ executeTakeFirst: { id: 'repo-1' } }),
    });
    await expect(repositoryKnownInitialized(db, 'repo-1')).resolves.toBe(true);
  });

  it('is false for a repository nothing is known about', async () => {
    const { db } = createDbMock({ selectFrom: chain({ executeTakeFirst: undefined }) });
    await expect(repositoryKnownInitialized(db, 'repo-1')).resolves.toBe(false);
  });

  it('records the first sighting only', async () => {
    const update = chain();
    const { db } = createDbMock({ updateTable: update });

    await markRepositoryInitialized(db, 'repo-1');

    expect(update.set).toHaveBeenCalledWith({ initialized_at: expect.any(Date) });
    expect(update.where).toHaveBeenCalledWith('id', '=', 'repo-1');
    expect(update.where).toHaveBeenCalledWith('initialized_at', 'is', null);
  });

  it('a relocation clears the sighting and stamps the move', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(relocationPatch(now)).toEqual({ initialized_at: null, relocated_at: now });
  });
});
