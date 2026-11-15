import { Kysely, sql } from 'kysely';

/**
 * Proxmox clusters register themselves: the first poll of a node agent that
 * announces an unknown PVE cluster creates its `proxmox_clusters` row (see
 * `ProxmoxService.registerCluster`). No user creates such a row, so
 * `owner_id` becomes nullable.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE proxmox_clusters ALTER COLUMN owner_id DROP NOT NULL`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Auto-registered clusters get the oldest admin as owner.
  await sql`
    UPDATE proxmox_clusters
       SET owner_id = (SELECT id FROM users ORDER BY is_admin DESC, created_at ASC LIMIT 1)
     WHERE owner_id IS NULL
  `.execute(db);
  await sql`ALTER TABLE proxmox_clusters ALTER COLUMN owner_id SET NOT NULL`.execute(db);
}
