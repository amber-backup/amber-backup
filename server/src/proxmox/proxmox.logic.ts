import type { ProxmoxRunItemStatus } from '../database/database.types';
import type {
  ProxmoxGuest,
  ProxmoxGuestResult,
  ProxmoxGuestType,
  ProxmoxInventory,
  ProxmoxJobConfig,
  ProxmoxRunSummary,
} from './proxmox.contract';

/** Pure decisions of the Proxmox run lifecycle, kept apart for unit tests. */

const ALL_TYPES: ProxmoxGuestType[] = ['qemu', 'lxc'];

/** Max. times an item follows a migrating guest before it gives up. */
export const MAX_ITEM_MOVES = 3;

/** Whether a job's selection includes the guest (pools/tags need the inventory entry). */
export function coversGuest(
  config: ProxmoxJobConfig | null,
  guest: Pick<ProxmoxGuest, 'vmid' | 'type' | 'template' | 'pool' | 'tags'>,
): boolean {
  if (!config) return false;
  const types = config.types?.length ? config.types : ALL_TYPES;
  if (!types.includes(guest.type)) return false;
  if (guest.template && !config.includeTemplates) return false;
  if ((config.excludeVmids ?? []).includes(guest.vmid)) return false;
  if (config.allGuests) return true;
  if (config.vmids.includes(guest.vmid)) return true;
  if (guest.pool && (config.pools ?? []).includes(guest.pool)) return true;
  const tags = new Set(guest.tags.map((t) => t.toLowerCase()));
  return (config.pveTags ?? []).some((t) => tags.has(t.toLowerCase()));
}

export interface GuestSelection {
  guests: ProxmoxGuest[];
  /** Explicitly selected VMIDs the inventory doesn't know (deleted guests). */
  missing: number[];
}

/**
 * The guests a run backs up. `only` restricts it (a retry repeats only the
 * guests that failed before); explicit VMIDs missing from the inventory are
 * reported so the run can fail them instead of silently skipping.
 */
export function selectGuests(
  inventory: ProxmoxInventory,
  config: ProxmoxJobConfig,
  only?: Set<number>,
): GuestSelection {
  const guests = inventory.guests
    .filter((g) => coversGuest(config, g))
    .filter((g) => !only || only.has(g.vmid))
    .sort((a, b) => a.vmid - b.vmid);
  const known = new Set(inventory.guests.map((g) => g.vmid));
  const missing = config.allGuests
    ? []
    : config.vmids
        .filter((id) => !known.has(id))
        .filter((id) => !(config.excludeVmids ?? []).includes(id))
        .filter((id) => !only || only.has(id));
  return { guests, missing: [...new Set(missing)].sort((a, b) => a - b) };
}

export interface ClaimCandidate {
  id: string;
  jobId: string;
  /** The job's limits. */
  parallelPerNode: number;
  maxParallel: number | null;
}

/**
 * Which queued items of a node an agent may start now: per job at most
 * `parallelPerNode` running on this node and `maxParallel` running across the
 * cluster. Candidates are in queue order.
 */
export function pickClaimable(
  candidates: ClaimCandidate[],
  runningOnNode: Map<string, number>,
  runningInCluster: Map<string, number>,
): string[] {
  const node = new Map(runningOnNode);
  const cluster = new Map(runningInCluster);
  const picked: string[] = [];
  for (const c of candidates) {
    const onNode = node.get(c.jobId) ?? 0;
    const inCluster = cluster.get(c.jobId) ?? 0;
    if (onNode >= Math.max(1, c.parallelPerNode)) continue;
    if (c.maxParallel != null && inCluster >= c.maxParallel) continue;
    picked.push(c.id);
    node.set(c.jobId, onNode + 1);
    cluster.set(c.jobId, inCluster + 1);
  }
  return picked;
}

export interface SettledItem {
  vmid: number;
  name: string;
  status: ProxmoxRunItemStatus;
  result: ProxmoxGuestResult | null;
  error: string | null;
}

export function isOpen(status: ProxmoxRunItemStatus): boolean {
  return status === 'queued' || status === 'running';
}

export function summarize(items: SettledItem[]): ProxmoxRunSummary {
  const s: ProxmoxRunSummary = {
    total: items.length,
    success: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    dataAdded: 0,
    bytesRead: 0,
  };
  for (const item of items) {
    if (item.status === 'success') s.success++;
    else if (item.status === 'failed') s.failed++;
    else if (item.status === 'skipped') s.skipped++;
    else if (item.status === 'cancelled') s.cancelled++;
    s.dataAdded += item.result?.dataAdded ?? 0;
    s.bytesRead += item.result?.bytesRead ?? 0;
  }
  return s;
}

/**
 * The run's final status and error from its settled items. An empty run (no
 * guest matched) fails: a backup that backs up nothing is a misconfiguration.
 */
export function runOutcome(items: SettledItem[]): {
  status: 'success' | 'failed';
  error: string | null;
} {
  if (items.length === 0) {
    return { status: 'failed', error: 'No guest of the cluster matches the job\'s selection.' };
  }
  const failed = items.filter((i) => i.status === 'failed' || i.status === 'cancelled');
  if (failed.length === 0) return { status: 'success', error: null };
  const detail = failed
    .slice(0, 5)
    .map((i) => `${i.vmid}${i.name ? ` (${i.name})` : ''}: ${i.error ?? i.result?.error ?? i.status}`)
    .join('; ');
  const more = failed.length > 5 ? `; … ${failed.length - 5} more` : '';
  return {
    status: 'failed',
    error: `${failed.length} of ${items.length} guests failed — ${detail}${more}`,
  };
}

/** One log line per guest for the run's log. */
export function runLog(items: SettledItem[]): string {
  return items
    .map((i) => {
      const r = i.result;
      const parts = [`guest ${i.vmid}${i.name ? ` (${i.name})` : ''}: ${i.status}`];
      if (r?.method) parts.push(`method ${r.method}`);
      if (r?.cbt) parts.push(`cbt ${r.cbt}${r.cbtReason ? ` (${r.cbtReason})` : ''}`);
      if (r?.consistency) parts.push(`consistency ${r.consistency}`);
      if (r?.snapshotId) parts.push(`snapshot ${r.snapshotId}`);
      if (i.error ?? r?.error) parts.push(`error: ${i.error ?? r?.error}`);
      return parts.join(', ');
    })
    .join('\n');
}

/**
 * Aggregated live progress of a run from its items. Bytes add up over all
 * guests — a finished guest keeps what it read (its result), a running one
 * counts with its own figures. The percentage is weighted by bytes once every
 * guest's size is known, else it is the mean of the guests' percentages
 * (finished ones count as 1).
 */
export function aggregateProgress(
  items: {
    status: ProxmoxRunItemStatus;
    progress: Record<string, unknown> | null;
    result?: Record<string, unknown> | null;
  }[],
): Record<string, number> {
  let done = 0;
  let percent = 0;
  let bytesDone = 0;
  let totalBytes = 0;
  let sizesKnown = true;
  for (const item of items) {
    if (!isOpen(item.status)) {
      done++;
      percent += 1;
      const r = item.result ?? {};
      const read = num(r.totalBytes) || num(r.bytesRead);
      bytesDone += read;
      totalBytes += read;
      continue;
    }
    const p = item.progress ?? {};
    percent += num(p.percentDone);
    bytesDone += num(p.bytesDone);
    totalBytes += num(p.totalBytes);
    if (num(p.totalBytes) <= 0) sizesKnown = false;
  }
  const total = items.length;
  const byBytes = sizesKnown && totalBytes > 0;
  return {
    percentDone: total ? Math.min(1, byBytes ? bytesDone / totalBytes : percent / total) : 0,
    bytesDone,
    totalBytes,
    filesDone: done,
    totalFiles: total,
    guestsDone: done,
    guestsTotal: total,
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
