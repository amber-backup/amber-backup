# Proxmox VE: VM and container backups (PBS replacement)

Date: 2026-11-14 · Status: implemented on `feat/proxmox`, **untested on a real PVE**

> Everything PVE-specific (command lines, paths, QMP/NBD behaviour) is built on
> assumptions and verified only against the simulated cluster
> (`AMBER_PROXMOX_MOCK`). The "Open questions" at the end are the checklist for
> the first real-host test. The section "Implementation decisions (v1)" below
> overrides the earlier sections where they differ.

## Implementation decisions (v1)

Shared types: `server/src/proxmox/proxmox.contract.ts` (mirrored by
`agent/proxmox.go` and `client/src/core/api.ts`).

**Cluster identity and nodes.** A node agent announces `PollDto.proxmox`
(`ProxmoxAgentInfo`): `clusterId` = sha256 of `/etc/pve/pve-root-ca.pem`
(shared by all nodes of a cluster, stable — unlike the daily-rotated authkey),
corosync `clusterName`, `node`, `pveVersion`. Stored on `agents.proxmox_info`.
There is no node table: a cluster's node agents are the agents whose
`proxmox_info.clusterId` equals `proxmox_clusters.pve_cluster_id`. Creating a
cluster = picking one announcing agent (`GET /proxmox/candidates`), which
becomes the **primary agent**.

**Primary agent.** Reads the inventory, runs the per-run retention task, and is
`backup_jobs.agent_id` of every job of the cluster — so integrity checks and
stats tasks keep working unchanged. Changing the primary moves the jobs along
(like a Hyper-V host's agent). If the primary is offline, the inventory goes to
any online node agent.

**Runs.** `claimBackupTasks` skips `source_kind = 'proxmox'`. `ProxmoxService`
expands queued Proxmox runs (interval + on every poll) into
`proxmox_run_items` against the cached inventory (requested fresh when older
than 10 min; expansion waits up to 2 min for it, then uses what it has). The
run row goes `running` with `agent_id` = primary. Items are claimed by the node
agent of the item's node, within `parallelPerNode` / `maxParallel`; task type
`proxmox-backup`, task id = item id. A retry run expands only the guests that
failed in the run it repeats.

**New repositories.** Until a job has backed up one guest, the server hands
out its guests one at a time cluster-wide, and the agent serializes
`ensureInitialized` per repository (re-checking the config after a failed
`init`). Parallel `restic init` on a fresh repository (several guests, several
nodes) otherwise leaves config and keys under different master keys — found in
the integration run, see "Verification status".

**Agent concurrency.** `proxmox-backup` tasks bypass the agent's serial worker
and run concurrently (the server caps them); everything else stays serial.

**Moved guests.** Result `status: 'moved'` + `movedTo` → item back to `queued`
on that node (at most 3 moves, then failed).

**Stuck items.** Queued item whose node has no agent at all → failed at once
("no Amber agent on node X"). Queued longer than the job's time limit (default
6 h) → failed. Running item whose agent has been offline > 30 min → failed.

**Settling.** When every item is terminal: `stats.proxmoxGuests`
(`ProxmoxRunSummary`), run status `success` if no item failed (skipped is
fine), else `failed`; `proxmox_job_guests` updated (parent snapshot + CBT state
of each successful guest). With retention configured the run stays `running`
and a `proxmox-retention` task (`pveret-<runId>`) goes to the primary agent:
`restic forget --host pve-<slug> --tag amber-proxmox --group-by host,tags` +
prune + repo stats, recorded like a backup's (forget_result, prune activity,
repository stats). Then the final status is written and `retries.finalize()`
runs (retry / notification).

**Cancel.** Cancelling the run cancels its queued/running items;
`GET me/tasks/:id/state` also resolves item ids (cancelled when the item or its
run is cancelled).

**Scripts.** pre/post scripts run per guest on the node, with
`AMBER_PVE_VMID`, `AMBER_PVE_TYPE`, `AMBER_PVE_NODE` added to the usual env.

**Stale state.** Leftover `amber-*` PVE snapshots and a leftover `backup` lock
taken by Amber are cleaned up at the start of the guest's next backup; the
inventory lists them. No manual cleanup action in v1.

**restic.** Proxmox tasks need restic ≥ 0.17 (`--stdin-from-command`); the
agent uses its managed/bundled restic when the host's is older.

**API** (`/api/proxmox`, admin/manage like Hyper-V hosts):
`GET clusters`, `POST clusters {name, primaryAgentId}`, `GET clusters/:idOrSlug`,
`PATCH clusters/:idOrSlug {name?, primaryAgentId?}`, `DELETE clusters/:idOrSlug`,
`POST clusters/:idOrSlug/refresh`, `GET candidates`, `GET summary`,
`GET clusters/:idOrSlug/guests/:vmid/snapshots`, `GET runs/:runId/items`.
Jobs: `sourceKind: 'proxmox'`, `proxmoxClusterId`, `proxmoxConfig`.
Restores: `mode: 'proxmox'`, `destination.proxmox` (`ProxmoxRestoreSpec`);
the server picks the agent of `targetNode`.

**Migration** `026_proxmox`: `agents.proxmox_info`, `proxmox_clusters`,
`proxmox_run_items`, `proxmox_job_guests`, `backup_jobs.proxmox_cluster_id` +
`proxmox_config`, source kind and restore mode `proxmox`.

## Verification status (2026-11-14)

What ran, all without a real PVE host:

- Unit/e2e tests: server jest (Proxmox service, dispatch, DTOs), Go tests incl.
  `AMBER_TEST_RESTIC` e2e against the simulated cluster with real restic and
  FUSE (vzdump, block incremental, CT files, vm-files, live restore).
- Integration run: the built server against real PostgreSQL 17 (PGlite) —
  all migrations up, `026_proxmox` down/up — with two real agent binaries as
  nodes `pve1`/`pve2` of one simulated cluster and a restic REST server:
  cluster registration from the poll announcements, inventory, two backup runs
  (block full → incremental reading 0 bytes, CT files, vzdump fallback, guest on
  the second node), retention task, and through the restore API: VM and CT as
  new guests (disks byte-identical), CT files back into the CT, files from a VM
  disk into a node folder, live restore (disk byte-identical).
- UI: screenshots of cluster/guests, job editor, per-guest run items, restore
  dialog, desktop and 390 px mobile.
- It found and fixed: the Hyper-V check constraint from 025 rejected every
  non-file job (026 narrows it to Hyper-V jobs), and the parallel `restic init`
  race above.

Not verified: anything marked `ASSUMPTION(pve)` in `agent/proxmox*.go` — the
real `qm`/`pct`/`vzdump`/`qmrestore`/`pvesm`, QMP/NBD on PVE's QEMU, storage
snapshot paths, loop/partition mounts. That needs the real-host test.

## Goal

Amber backs up Proxmox VE guests — QEMU VMs **and** LXC containers — on single
nodes and clusters, well enough to replace Proxmox Backup Server (PBS):
incremental VM backups, file-level container backups, restores through PVE's
own tools, all in restic repositories managed from the Amber dashboard.

Decisions taken:

- **Agent on every PVE node** (Variante A). PVE is Debian, so the existing Linux
  agent runs as root via systemd. No SSH, no PVE API tokens.
- **Clusters are first-class**: one Amber "Proxmox cluster" spans all nodes; each
  guest is backed up by the agent of the node that currently owns it.
- **LXC is first-class**: file-level, deduplicated, with single-file restore.
- **PBS parity** is the yardstick (see the table at the end).

## PBS parity — what we build vs. what PBS does

| PBS feature | Amber | Phase |
|---|---|---|
| VM backup, works on every storage | `vzdump --stdout` into restic (fallback method) | 1 |
| Incremental VM backup (dirty bitmap, only changed blocks read) | Block method: storage snapshot + QEMU dirty bitmap + segment view | 3 |
| CT backup as file archive (pxar), single-file restore | CT file method: storage snapshot mounted read-only, restic file backup | 2 |
| Dedup, compression, encryption | restic | — |
| Retention, prune/GC, verify | existing retention / prune runner / integrity checks | — |
| File restore from VM backups | `restic mount` → raw image view → loop → ro mount → copy to a node folder | 4 |
| Live restore (start VM before restore finished) | qcow2 overlays on the image view + `qm disk move` | 5 |
| Sync to second datastore | generic `restic copy` feature (not Proxmox-specific) | separate |
| Backups visible in the PVE GUI (storage plugin) | **not planned** — Amber UI only | — |

## Concepts

- **Proxmox cluster** (`proxmox_clusters`): a standalone node is a one-node
  cluster. Identified by the corosync cluster name (null for standalone).
- **Node** (`proxmox_nodes`): a PVE node name, linked to the agent running on it.
  Agents announce `{ node, cluster, pveVersion }` in the poll, so the server
  links them automatically; nodes without an agent are shown as a warning
  ("guests on pve3 can't be backed up").
- **Guest**: `(cluster, vmid)`, type `qemu` | `lxc`. VMIDs are unique in a
  cluster but get reused after deletion — the manifest stores name + config so
  the UI can show "vmid 105 used to be 'web01'".
- **Method** per guest, resolved by the agent at backup time:
  - `vzdump` — `vzdump --stdout` streamed into restic. Works everywhere, full read.
  - `block` (VMs) — segment view of a storage snapshot, incremental via dirty bitmap.
  - `files` (CTs) — restic file backup of the mounted storage snapshot.
  - Job setting `auto` picks `block`/`files` when the guest's storages support
    snapshots and falls back to `vzdump` otherwise; `vzdump` forces the fallback.

## restic layout

- One restic snapshot per guest per run, like Hyper-V.
- `--host <cluster-slug>` for **all** nodes. A guest that migrates between nodes
  must keep its parent snapshot and its retention group; the node's hostname
  would break both. The node goes into a tag instead.
- Tags: `amber-proxmox`, `pve-cluster:<slug>`, `pve-guest:<vmid>`,
  `pve-type:qemu|lxc` (+ the job's own tags). No node/method/name tags: with
  `--group-by host,tags` they would split a guest's retention group after a
  migration or method change. The method follows from the paths (a vzdump
  snapshot holds `vzdump-<type>-<vmid>.vma|tar`, block/files snapshots the
  guest's mount directory) and the manifest.
- Paths are stable per guest: `/run/amber-agent/pve/<vmid>/…` (the agent mounts
  there), so restic tree comparison works across runs and nodes.
- Every snapshot holds `manifest.json` (guest type, name, method, PVE version,
  disks with storage/size/format, idmap for unprivileged CTs, segment size,
  CBT info) and the raw guest config (`qemu-server.conf` / `lxc.conf`).
- The parent is passed explicitly (`--parent <id>`) from server state
  (`proxmox_job_guests.last_snapshot_id`), never guessed by restic.

### Method `vzdump`

```
restic backup --stdin-from-command --stdin-filename /run/amber-agent/pve/<vmid>/vzdump.vma \
  --host <cluster> --tag … -- vzdump <vmid> --stdout --compress 0 --mode snapshot
```

- `--stdin-from-command` (restic ≥ 0.17) fails the snapshot when vzdump exits
  non-zero. Debian 12's restic is 0.14, so Proxmox tasks require ≥ 0.17 and
  use the bundled restic otherwise.
- `--compress 0` is mandatory (a zstd stream doesn't deduplicate); restic
  compresses.
- `--mode` from the job (`snapshot` | `suspend` | `stop`). CTs produce a tar
  stream (`vzdump.tar`).
- No separate `manifest.json`: restic can't mix stdin and files in one
  snapshot. The archive carries the guest config itself; name and method go
  into tags (`pve-name:<name>`) and into `proxmox_run_items`.
- Restore: `restic dump <snap> …/vzdump.vma | qmrestore - <vmid> [--storage] [--unique]`
  and `… | pct restore <vmid> - [--storage]`.

### Method `block` (VMs, the incremental path)

**Point in time**: `qm snapshot <vmid> amber-<runid> --vmstate 0`. PVE creates the
storage snapshots (ZFS, LVM-thin, Ceph RBD, qcow2 internal) and freezes the
guest's filesystems through the guest agent when it's enabled → consistency
`application`, else `crash`. Afterwards `qm set --lock backup` keeps PVE from
migrating, deleting or snapshotting the VM until we're done.

**Reading a snapshot** — one adapter per storage type returns a readable device:

| Storage | Read path |
|---|---|
| zfspool | `/dev/zvol/<pool>/<vol>@<snap>` (temporarily `snapdev=visible`) |
| lvmthin | snapshot LV activated with `lvchange -ay -K` |
| rbd | `rbd map --read-only <pool>/<img>@<snap>` |
| dir/nfs/cifs (qcow2) | `qemu-nbd --read-only -l <snap>` on the image |
| raw on dir/nfs, LVM thick, iSCSI | unsupported → `vzdump` fallback |

**Segment view**: the agent serves a read-only FUSE filesystem
(`hanwen/go-fuse`) at `/run/amber-agent/pve/<vmid>/`:

```
manifest.json
qemu-server.conf
disks/scsi0/000/000.seg … 255.seg   # 16 MiB segments, 256 per directory
disks/scsi0/001/…
disks/efidisk0/…  disks/tpmstate0/…
```

- 256 segments per directory, so unchanged 4 GiB ranges keep identical restic
  tree blobs.
- Each segment's mtime is the time it last changed according to change
  tracking; unchanged segments keep the mtime recorded in the parent snapshot.
- `restic backup --parent <p> --ignore-inode --ignore-ctime` then **reads only
  segments with a new mtime** and reuses the parent's blob list for the rest.
  This gives incremental reads with stock restic and no custom repository code.

**Change tracking (CBT)** — QEMU dirty bitmaps over QMP
(`/var/run/qemu-server/<vmid>.qmp`, short-lived connections only):

1. `block-dirty-bitmap-add` bitmap `amber-<job>-<seq N>` on every disk node.
2. `qm snapshot` (point in time S_N).
3. Read the bitmap of the **previous** run (N-1) through an NBD export of the
   live node (`block-export-add`, meta context `qemu:dirty-bitmap:<name>`,
   `NBD_CMD_BLOCK_STATUS`). It was created before S_N-1, so it covers every
   write since S_N-1 — a superset, which is what correctness needs.
4. Map dirty extents → dirty segments → new mtimes; back up.
5. On success: remove bitmap N-1, keep N. On failure: keep N-1 and also remove
   N, so the next run uses N-1 again.

A full read (every segment gets a new mtime, restic still deduplicates) happens
when: no previous bitmap (first run, VM was stopped/restarted, live-migrated
without bitmap migration, QEMU restarted), disk resized, segment size changed,
parent snapshot missing, or the VM isn't running (stopped VMs have no QEMU).
Each job tracks its own bitmaps, so two jobs on the same VM don't interfere;
PVE's own PBS bitmap is never touched. The run result records
`cbt: 'incremental' | 'full'` plus the reason per guest.

**Cleanup**: `qm unlock`, `qm delsnapshot amber-<runid>`, unmap/deactivate
devices, unmount FUSE. Leftover `amber-*` snapshots, locks and bitmaps (agent
crash) show in the inventory with a "clean up" action, like Hyper-V's stale
checkpoints.

### Method `files` (CTs)

- `pct snapshot <vmid> amber-<runid>`; mount the rootfs and every mount point
  with `backup=1` read-only, nested at their in-container paths under
  `/run/amber-agent/pve/<vmid>/root/`:
  ZFS subvol → `<mountpoint>/.zfs/snapshot/<snap>` (bind), LVM-thin → activated
  snapshot LV `mount -o ro,noload`, RBD → `rbd map --read-only` + mount.
  `dir` storage has no snapshots → `vzdump` fallback (or `suspend` mode).
- restic file backup with `--parent`, excludes from the job plus vzdump's
  defaults (`/tmp/?*`, `/var/tmp/?*`, `/var/run/?*.pid`).
- Ownership is stored **as seen on the host** (unprivileged: 100000+). File
  restores into the CT then come out right without remapping; the idmap is in
  the manifest.
- Restores: the existing `original` / `alternate_path` / `download` modes work
  on the files; `original` resolves the CT's live rootfs (`/proc/<pid>/root` of
  a running CT, `pct mount` for a stopped one).

## Restore: always through PVE's own tools

Instead of writing VM configs or allocating volumes ourselves, the agent
**synthesizes a vzdump archive as a stream** and pipes it into PVE's restore
command, which handles VMID/volume allocation, storage mapping, `--unique`
(new MACs), cluster locks and config rewriting:

- `vzdump` snapshots: `restic dump` the archive as is.
- `block` snapshots: a Go **VMA writer** (`vma_spec.txt` from pve-qemu) reads
  the segments in disk order (`restic dump --archive tar …/disks`) and emits
  VMA with the stored config → `qmrestore - <vmid>`. Zero segments are skipped,
  so thin targets stay sparse.
- `files` snapshots: a tar rewriter turns `restic dump --archive tar` into a
  vzdump-style CT archive (`./` paths, `./etc/vzdump/pct.conf`, host uids
  shifted back to container uids for unprivileged CTs) → `pct restore - <vmid>`.

Restore options (`destination.proxmox`): target node, new VMID (default
`/cluster/nextid`) or replace the original (`--force`, guest stopped first),
target storage (one default + optional per-disk mapping), `unique`, name, start
afterwards, bandwidth limit. Runs on the target node's agent.

### Disk-image restores of `block` snapshots (phases 4 and 5)

Both read a block snapshot as disk images instead of streaming a VMA
(`agent/proxmox_vmrestore.go`, `proxmox_concat*.go`):

1. `restic mount` of the repository under
   `/run/amber-agent/pve/restore-<id>/repo` (keeps restic's normal lock, so a
   prune can't pull data away mid-restore).
2. A second read-only FUSE view serves each disk as `<key>.raw`: a
   `concatImage` maps image offsets onto `disks/<key>/<dir>/<seg>.seg` of the
   mounted snapshot and zero-fills missing or short segments.
3. Cleanup always runs in reverse order (detach filesystems, unmount the image
   view, stop `restic mount`); the work directory is only removed once nothing
   is mounted below it.

**vm-files** (`action: 'vm-files'`, qemu only): `targetPath` = absolute folder
on the target node (not `/`); the restore's `includedPaths` are paths inside
the guest, optionally prefixed `p2:`, `scsi0:` or `scsi0p1:`; none = every
filesystem completely. The backend attaches each data disk (not efidisk0 /
tpmstate0): `losetup --read-only --find --show --partscan`, `lsblk --json`,
then mounts every partition (or a whole-disk filesystem, `p0`) read-only —
ext2/3/4 `ro,noload`, xfs `ro,norecovery,nouuid`, btrfs
`ro,rescue=nologreplay`, vfat `ro`, ntfs via ntfs3 or ntfs-3g. LVM physical
volumes, LUKS, swap and unknown filesystems are skipped with a warning
(activating a guest VG on the host could clash with host VGs). Matches are
copied to `<targetPath>/<disk>-p<N>/<path>` keeping modes, times, symlinks and
— as root — ownership; nothing matching anywhere fails the restore.

**Live restore** (`action: 'guest'`, `liveRestore: true`, `overlayStorage`;
qemu + block only, always a new VMID): per disk a qcow2 overlay
`<overlayStorage>:<vmid>/vm-<vmid>-amberlive-<key>.qcow2` backed by the raw
image (`qemu-img create -f qcow2 -F raw -b <image>`), the stored config with
its disks rewritten to the overlays (disks not in the backup and `unusedN`
dropped, `unique` → new MACs + vmgenid, name) written as
`/etc/pve/qemu-server/<vmid>.conf` (O_EXCL), `qm start`, then
`qm disk move <vmid> <key> <storage> --delete 1` per disk into `storage` (or
the original storage), with progress. Until the last move finishes the VM
reads through this agent from the repository — like a PBS live restore the
task must stay up. Failure before the start removes everything; a failed move
after the start **stops the VM** (its remaining disks would lose their backing
when the task ends) and keeps config + overlays for inspection. The server
checks the overlay storage against the inventory (dir/nfs/cifs/glusterfs with
`images` content, reachable from the target node).

## Server

### Migration `026_proxmox`

- `proxmox_clusters`: id, name, slug, cluster_name, inventory (JSON),
  inventory_at / inventory_error / inventory_requested_at, owner_id, timestamps.
- `proxmox_nodes`: cluster_id, node, agent_id (nullable, unique), last_seen.
- `backup_jobs`: `source_kind` += `proxmox`; `proxmox_cluster_id`,
  `proxmox_config` (JSON).
- `proxmox_run_items`: run_id, vmid, guest_type, name, node, agent_id, status
  (`queued | running | success | failed | skipped | cancelled`), method,
  consistency, cbt, snapshot_id, stats, error, log, started_at, finished_at.
- `proxmox_job_guests`: job_id, vmid, last_snapshot_id, last_success_at,
  last_status, cbt_bitmap, cbt_node — parent + bitmap state, and the source of
  the dashboard's "guests without backup / failing" view.
- `restore_runs.mode` += `proxmox`; `destination.proxmox` spec.
- `database.types.ts` updated by hand.

`ProxmoxJobConfig`: `allGuests`, `vmids`, `excludeVmids`, `pools`, `pveTags`,
`types` (`qemu`/`lxc`), `includeTemplates` (default false), `vmMethod` /
`ctMethod` (`auto` | `vzdump`), `vzdumpMode`, `requireConsistent` (fail instead
of crash-consistent), `parallelPerNode` (1–4), `maxParallel` (cluster-wide
cap, protects shared Ceph/NFS).

### Module `server/src/proxmox/`

Controller `/api/proxmox`: clusters CRUD, `POST clusters/:id/refresh`,
`GET summary`, `GET guests/:vmid/snapshots`, `POST clusters/:id/cleanup`
(stale snapshots/locks). `proxmox.contract.ts` = task payload shared with
`agent/proxmox.go`.

### Runs across several agents (new compared to Hyper-V)

A Hyper-V run is one task for one agent. A cluster run needs many:

1. The scheduler creates the `job_runs` row as usual (`agent_id null`).
   `ProxmoxService.expand(run)` resolves the selection against the inventory
   (refreshed first if older than 10 min) into `proxmox_run_items`, each with
   the guest's current node.
2. Poll: a `proxmox`-capable agent claims queued items of **its** node, within
   `parallelPerNode` and `maxParallel` → `proxmox-backup` task, task id = item
   id, payload with parent snapshot + previous bitmap.
3. **Migration**: the agent checks the guest is local
   (`/etc/pve/local/{qemu-server,lxc}/<vmid>.conf`). If not, it reports
   `moved` with the node that holds it now; the server reassigns the item.
4. Items for a node without an online agent fail after the job's time limit
   ("no online agent on node pve3").
5. When all items are settled: run `success` if none failed, else `failed`;
   `stats.proxmoxGuests` summary; one notification; `proxmox_job_guests`
   updated.
6. **Retention** runs once per run, after all items: one `forget` task
   (`--tag amber-proxmox,pve-cluster:<slug> --group-by host,tags`) to one node
   agent; prune through the existing prune runner (`parent_run_id`). Doing it
   per guest (like Hyper-V) would make parallel agents fight over the exclusive
   lock.
7. Retries (`022_job_retries`) repeat **only the failed items**.
8. Cancel: run cancelled → items cancelled; `GET me/tasks/:id/state` also
   looks up item ids, so the agents stop as for other tasks.

Places that assume "location `agent` ⇒ `job.agent_id` set" need an audit
(scheduler, run listing, agent deletion guards, RBAC on agent resources).

### Inventory

Task `pveinv-<clusterId>`, claimed by any online node agent. One call is enough
for the whole cluster: `pvesh get /cluster/resources --type vm` plus the
configs, which every node can read in `/etc/pve/nodes/*/{qemu-server,lxc}/`
(pmxcfs). Reports guests (vmid, type, name, node, status, template, lock, HA,
pool, tags, guest agent, disks + storages), storages (type, shared,
snapshot-capable → which method `auto` will pick), nodes (online, agent
present) and stale `amber-*` snapshots/locks. Refreshed hourly and on demand.

## Agent

Linux-only (`//go:build linux`). Detects PVE via `/etc/pve` + `pveversion` and
announces capability `proxmox` + node/cluster info.

- `proxmox.go` — wire types (mirror `proxmox.contract.ts`), dispatch, item flow
- `proxmox_pve.go` — `pveBackend` interface over `pvesh`, `qm`, `pct`,
  `vzdump`, `qmrestore`, `pct restore` (real + mock, like `hypervBackend`)
- `proxmox_vzdump.go` — vzdump method
- `proxmox_block.go` — snapshot adapters, segment FUSE view, mtime map
- `proxmox_qmp.go`, `proxmox_nbd.go` — minimal QMP client; minimal NBD client
  (handshake + `BLOCK_STATUS` only), so nodes need no extra packages
- `proxmox_lxc.go` — CT snapshot mount tree
- `proxmox_restore.go` — VMA writer, CT tar rewriter, restore flow
- `proxmox_mock.go` — `AMBER_PROXMOX_MOCK=<dir>`: simulated cluster with fake
  guests, disks as files, settable dirty extents, `qmrestore`/`pct restore`
  that write their input to disk

New dependency: `github.com/hanwen/go-fuse/v2` (pure Go). PVE already relies on
FUSE (pmxcfs), so `/dev/fuse` is there.

## Client

- `pages/proxmox.tsx`: clusters → nodes (agent status) → guests (type, status,
  method `auto` would use, last backup, CBT state, stale snapshots).
- Job editor: `source_kind` Proxmox with the selection (all / ids / pools /
  tags / types), method, mode, parallelism.
- Run detail: per-guest rows (`proxmox_run_items`) with incremental/full and
  data read vs. added.
- Restore dialog for guests; file browser restores for `files` snapshots.
- Dashboard: guests without a job / failing, like Hyper-V.
- All strings in `i18n/en` and `i18n/de`.

## Phases

0. **Spike on a real PVE** (nested PVE in a VM, 3-node nested cluster) — needed
   before phase 3, worth doing first. Answers the open technical questions below.
1. **Foundation + `vzdump` method**: migration, module, inventory, cluster
   dispatch with items/migration/retention, VM + CT backup via vzdump, restore
   via `qmrestore -` / `pct restore -`, mock, E2E with real restic, UI basics.
   Shippable and useful on its own (full reads, deduplicated storage).
2. **CT `files` method** + file restores into CTs.
3. **VM `block` method + CBT**: snapshot adapters, segment view, dirty bitmaps,
   VMA writer. This is what makes it a PBS replacement.
4. **File-level restore from VM backups** (`vm-files`) — implemented as above;
   files go to a folder on the node (no browsing UI of guest filesystems yet).
5. **Live restore** — implemented as above.

## Testing

- Server: jest for selection, item expansion, per-node/cluster limits, moved
  items, finalization, item-only retries, retention-once.
- Agent with mock + real restic (`AMBER_TEST_RESTIC`): vzdump stream round
  trip; segment view where only dirty segments get read (restic's
  `files_changed`) and the restore is bit-identical; CT tar rewrite incl. uid
  shift; VMA writer against our own VMA reader.
- Real PVE (nested), manual checklist per phase: VM on ZFS/LVM-thin/Ceph/qcow2,
  with and without guest agent, running and stopped, live-migrated between two
  runs, HA guest, privileged + unprivileged CT, restore to another node/storage.
  The mock can't prove PVE's behaviour; nothing counts as verified until it ran
  on a real PVE.

## Open questions (to settle in the spike)

1. Do `qmrestore -` and `pct restore -` read from stdin as expected on PVE 8/9?
2. Does `qm snapshot` freeze filesystems through the guest agent on PVE 8/9?
3. Dirty bitmaps on PVE's QEMU: add/remove over QMP next to PVE's own monitor
   use, NBD export with the bitmap meta context, node names on PVE 8
   (`-drive`) vs. PVE 9 (`-blockdev`). Do bitmaps survive live migration?
4. How well do uncompressed VMA streams deduplicate run over run?
5. Segment size: 16 MiB (fewer files, more re-read per small write) vs. 4 MiB
   (like PBS, 4× the tree metadata).
6. Does `pct restore` of an unprivileged CT expect container uids in the
   archive (as vzdump writes them)?
7. Stopped VMs are read fully every run — worth detecting "not started since
   last backup" (e.g. from task log / config digest) to skip them?
8. vm-files: does a loop device over a FUSE file (served by the agent itself,
   reading from `restic mount`) work with `--partscan`, and do partitions show
   up after `udevadm settle`? Are ext4 `noload` / xfs `norecovery,nouuid`
   enough for crash-consistent images?
9. Live restore: does `pvesm path` resolve a not yet existing
   `vm-<vmid>-amberlive-<key>.qcow2`, does QEMU (cache=none → O_DIRECT) read
   the FUSE backing file (the view answers O_DIRECT opens with
   FOPEN_DIRECT_IO), does pmxcfs honour O_EXCL, and does `qm disk move
   --delete 1` on a running VM print parseable "transferred … of …" lines?
