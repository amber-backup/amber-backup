import type { ProxmoxGuest, ProxmoxInventory, ProxmoxJobConfig } from './proxmox.contract';
import {
  aggregateProgress,
  coversGuest,
  pickClaimable,
  runLog,
  runOutcome,
  selectGuests,
  summarize,
} from './proxmox.logic';

function guest(vmid: number, over: Partial<ProxmoxGuest> = {}): ProxmoxGuest {
  return {
    vmid,
    type: 'qemu',
    name: `g${vmid}`,
    node: 'pve1',
    status: 'running',
    template: false,
    tags: [],
    disks: [],
    autoMethod: 'block',
    staleSnapshots: [],
    ...over,
  };
}

const inventory: ProxmoxInventory = {
  clusterName: 'prod',
  pveVersion: 'pve-manager/8.2.4',
  readBy: 'pve1',
  nodes: [
    { name: 'pve1', online: true },
    { name: 'pve2', online: true },
  ],
  storages: [],
  guests: [
    guest(100),
    guest(101, { type: 'lxc', node: 'pve2', pool: 'web' }),
    guest(102, { tags: ['Prod', 'db'] }),
    guest(9000, { template: true }),
  ],
};

const all: ProxmoxJobConfig = { allGuests: true, vmids: [] };

describe('coversGuest', () => {
  it('covers every guest but templates and exclusions with allGuests', () => {
    expect(coversGuest(all, guest(100))).toBe(true);
    expect(coversGuest(all, guest(9000, { template: true }))).toBe(false);
    expect(coversGuest({ ...all, includeTemplates: true }, guest(9000, { template: true }))).toBe(true);
    expect(coversGuest({ ...all, excludeVmids: [100] }, guest(100))).toBe(false);
    expect(coversGuest(null, guest(100))).toBe(false);
  });

  it('honours the type filter', () => {
    expect(coversGuest({ ...all, types: ['lxc'] }, guest(100))).toBe(false);
    expect(coversGuest({ ...all, types: ['lxc'] }, guest(101, { type: 'lxc' }))).toBe(true);
  });

  it('selects by vmid, pool or tag (case-insensitive tags)', () => {
    const cfg: ProxmoxJobConfig = { allGuests: false, vmids: [100], pools: ['web'], pveTags: ['prod'] };
    expect(coversGuest(cfg, guest(100))).toBe(true);
    expect(coversGuest(cfg, guest(101, { pool: 'web' }))).toBe(true);
    expect(coversGuest(cfg, guest(102, { tags: ['Prod'] }))).toBe(true);
    expect(coversGuest(cfg, guest(103))).toBe(false);
  });
});

describe('selectGuests', () => {
  it('returns the covered guests sorted, and reports explicit vmids that are gone', () => {
    const { guests, missing } = selectGuests(inventory, {
      allGuests: false,
      vmids: [102, 100, 555],
    });
    expect(guests.map((g) => g.vmid)).toEqual([100, 102]);
    expect(missing).toEqual([555]);
  });

  it('restricts a retry to the guests that failed before', () => {
    const { guests, missing } = selectGuests(inventory, all, new Set([101]));
    expect(guests.map((g) => g.vmid)).toEqual([101]);
    expect(missing).toEqual([]);
  });
});

describe('pickClaimable', () => {
  const c = (id: string, jobId = 'job', parallelPerNode = 1, maxParallel: number | null = null) => ({
    id,
    jobId,
    parallelPerNode,
    maxParallel,
  });

  it('starts at most parallelPerNode items per job on a node', () => {
    expect(pickClaimable([c('a', 'job', 2), c('b', 'job', 2), c('c', 'job', 2)], new Map(), new Map())).toEqual([
      'a',
      'b',
    ]);
    expect(pickClaimable([c('a'), c('b')], new Map([['job', 1]]), new Map([['job', 1]]))).toEqual([]);
  });

  it('respects the cluster-wide cap', () => {
    expect(
      pickClaimable([c('a', 'job', 4, 3), c('b', 'job', 4, 3)], new Map(), new Map([['job', 2]])),
    ).toEqual(['a']);
  });

  it('counts each job on its own', () => {
    expect(pickClaimable([c('a', 'j1'), c('b', 'j1'), c('c', 'j2')], new Map(), new Map())).toEqual(['a', 'c']);
  });
});

describe('summarize / runOutcome', () => {
  const ok = { vmid: 100, name: 'web', status: 'success' as const, result: { dataAdded: 10, bytesRead: 100 } as never, error: null };
  const bad = { vmid: 101, name: 'db', status: 'failed' as const, result: null, error: 'vzdump exited 1' };
  const skip = { vmid: 102, name: '', status: 'skipped' as const, result: null, error: null };

  it('counts outcomes and bytes', () => {
    expect(summarize([ok, bad, skip])).toEqual({
      total: 3,
      success: 1,
      failed: 1,
      skipped: 1,
      cancelled: 0,
      dataAdded: 10,
      bytesRead: 100,
    });
  });

  it('succeeds when nothing failed (skipped is fine)', () => {
    expect(runOutcome([ok, skip])).toEqual({ status: 'success', error: null });
  });

  it('fails with the failing guests named', () => {
    const out = runOutcome([ok, bad]);
    expect(out.status).toBe('failed');
    expect(out.error).toContain('1 of 2 guests failed');
    expect(out.error).toContain('101 (db): vzdump exited 1');
  });

  it('fails an empty run', () => {
    expect(runOutcome([]).status).toBe('failed');
  });

  it('writes one log line per guest', () => {
    expect(runLog([ok, bad]).split('\n')).toHaveLength(2);
  });
});

describe('aggregateProgress', () => {
  it('counts finished items as done and running ones by their percentage', () => {
    const p = aggregateProgress([
      { status: 'success', progress: null },
      { status: 'running', progress: { percentDone: 0.5, bytesDone: 50, totalBytes: 100 } },
      { status: 'queued', progress: null },
      { status: 'queued', progress: null },
    ]);
    expect(p.percentDone).toBeCloseTo(1.5 / 4);
    expect(p.bytesDone).toBe(50);
    expect(p.guestsDone).toBe(1);
    expect(p.guestsTotal).toBe(4);
  });

  it('adds up the bytes of every guest and weights by them once all sizes are known', () => {
    // A 160 GB block guest at 20 % and a finished 9 GB vzdump guest.
    const p = aggregateProgress([
      { status: 'running', progress: { percentDone: 0.2, bytesDone: 32, totalBytes: 160 } },
      { status: 'success', progress: null, result: { bytesRead: 9, totalBytes: 9 } },
    ]);
    expect(p.totalBytes).toBe(169);
    expect(p.bytesDone).toBe(41);
    expect(p.percentDone).toBeCloseTo(41 / 169);
  });

  it('falls back to the mean percentage while a guest has no size yet', () => {
    const p = aggregateProgress([
      { status: 'running', progress: { percentDone: 0.5, bytesDone: 80, totalBytes: 160 } },
      { status: 'running', progress: { percentDone: 0, bytesDone: 5 } },
    ]);
    expect(p.totalBytes).toBe(160);
    expect(p.percentDone).toBeCloseTo(0.25);
  });
});
