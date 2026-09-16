import { Kysely, sql } from 'kysely';

/**
 * Agent labels and per-agent IP allowlist.
 *
 * `labels` are free-form admin tags for grouping agents. `allowed_ips` holds
 * IP addresses and CIDR ranges an agent's authenticated requests must come
 * from; an empty list allows any address (today's behaviour). `last_ip` is the
 * address of the agent's latest poll, so an admin can see what to allow
 * before locking the agent down.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('agents')
    .addColumn('labels', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('allowed_ips', 'jsonb', (c) =>
      c.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn('last_ip', 'text')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('agents')
    .dropColumn('last_ip')
    .dropColumn('allowed_ips')
    .dropColumn('labels')
    .execute();
}
