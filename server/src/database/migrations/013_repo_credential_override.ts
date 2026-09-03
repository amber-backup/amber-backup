import { Kysely } from 'kysely';

/**
 * Per-repository override of a connection's credentials.
 *
 * A connection (target) carries the shared backend credentials, but some
 * backends authenticate per repository — a restic REST server with
 * `--private-repos` gives every repository its own account. Fields marked
 * `overridable` in the backend registry may therefore be re-entered on the
 * backup job; the values are stored in a credential secret of their own and win
 * over the connection's when the repository is resolved.
 *
 * Restore runs snapshot the override alongside the repository password so a
 * queued restore keeps resolving even while the job is being edited. Its FK is
 * ON DELETE SET NULL so deleting the owning job never trips over a historical
 * restore run.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('repositories')
    .addColumn('credential_secret_id', 'uuid', (c) => c.references('secrets.id'))
    .execute();

  await db.schema
    .alterTable('restore_runs')
    .addColumn('credential_secret_id', 'uuid', (c) =>
      c.references('secrets.id').onDelete('set null'),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('restore_runs')
    .dropColumn('credential_secret_id')
    .execute();
  await db.schema
    .alterTable('repositories')
    .dropColumn('credential_secret_id')
    .execute();
}
