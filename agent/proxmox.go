package main

// Proxmox VE: inventory, backup and restore of VMs and containers.
//
// An agent runs on every PVE node. The server hands it one guest per
// proxmox-backup task (task id = the run item), always for a guest on this
// node; a guest that migrated meanwhile is reported back as "moved". The
// agent drives PVE through a pveBackend: the real one (proxmox_pve_linux.go)
// shells out to qm/pct/vzdump/pvesh and reads /etc/pve, the mock
// (proxmox_mock.go, AMBER_PROXMOX_MOCK) simulates a cluster for tests.
//
// Three methods (see docs/superpowers/specs/2026-11-14-proxmox-design.md):
//   vzdump — `vzdump --stdout` streamed into restic; works everywhere.
//   block  — VMs: PVE snapshot, disks served as a FUSE segment view; QEMU
//            dirty bitmaps tell which segments changed, restic --parent
//            reads only those.
//   files  — CTs: PVE snapshot mounted read-only, restic file backup.
// Every snapshot of a cluster has host pve-<slug> and the tags
// amber-proxmox, pve-cluster:<slug>, pve-guest:<vmid>, pve-type:<type>.
// Restores stream a synthesized vzdump archive into qmrestore / pct restore.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var errGuestNotFound = errors.New("guest not found")

// pveDiskReader reads a snapshot of a VM disk.
type pveDiskReader interface {
	io.ReaderAt
	Size() int64
	Close() error
}

// pveRestoreOpts are the flags handed to qmrestore / pct restore.
type pveRestoreOpts struct {
	Storage    string
	Unique     bool
	Force      bool
	BwlimitKiB int
}

type pveBackend interface {
	Name() string
	// Info identifies this node and its cluster (nil error = it is a PVE node).
	Info(ctx context.Context) (*ProxmoxAgentInfo, error)
	Inventory(ctx context.Context) (*ProxmoxInventory, error)
	// LocateGuest finds the node and type of a guest (errGuestNotFound).
	LocateGuest(ctx context.Context, vmid int) (node, typ string, err error)
	GuestConfig(ctx context.Context, typ string, vmid int) (*pveConfig, error)
	GuestStatus(ctx context.Context, typ string, vmid int) (string, error)
	Storages(ctx context.Context) (map[string]*pveStorageCfg, error)
	Snapshot(ctx context.Context, typ string, vmid int, name string) error
	DeleteSnapshot(ctx context.Context, typ string, vmid int, name string) error
	// SetLock sets a config lock; "" removes it.
	SetLock(ctx context.Context, typ string, vmid int, lock string) error
	// VzdumpCommand is the argv restic runs (--stdin-from-command).
	VzdumpCommand(ctx context.Context, typ string, vmid int, mode string) ([]string, error)
	OpenSnapshotDisk(ctx context.Context, vmid int, d ProxmoxGuestDisk, st *pveStorageCfg, snap string) (pveDiskReader, error)
	// MountSnapshotVolume mounts a CT volume's snapshot read-only at target.
	MountSnapshotVolume(ctx context.Context, vmid int, d ProxmoxGuestDisk, st *pveStorageCfg, snap, target string) (func() error, error)
	AddBitmaps(ctx context.Context, vmid int, keys []string, name string) error
	RemoveBitmaps(ctx context.Context, vmid int, keys []string, name string) error
	// DirtyExtents reads a bitmap of a running VM (errNoBitmap when gone).
	DirtyExtents(ctx context.Context, vmid int, key, bitmap string) ([]pveExtent, error)
	NextVMID(ctx context.Context) (int, error)
	StopGuest(ctx context.Context, typ string, vmid int) error
	StartGuest(ctx context.Context, typ string, vmid int) error
	SetName(ctx context.Context, typ string, vmid int, name string) error
	// RestoreGuest feeds a vzdump-format archive to qmrestore / pct restore.
	RestoreGuest(ctx context.Context, typ string, vmid int, opts pveRestoreOpts, archive io.Reader, onLog func(string)) error
	// CTRootfs is the container's root as the host sees it (for file restores).
	CTRootfs(ctx context.Context, vmid int) (string, func() error, error)

	// AttachImage makes the filesystems on a raw disk image (of VM vmid's disk
	// key) readable below workdir, read-only; the func detaches them again.
	// Filesystems it can't mount come back as warnings.
	AttachImage(ctx context.Context, vmid int, key, image, workdir string) ([]pveGuestPartition, []string, func() error, error)
	// CreateOverlay creates a qcow2 volume for VM vmid on storage, backed by
	// the raw image (live restore), and returns its volume id.
	CreateOverlay(ctx context.Context, storage string, vmid int, key, image string, size int64) (string, error)
	FreeVolume(ctx context.Context, volid string) error
	// WriteGuestConfig registers a new VM on this node; it fails when vmid exists.
	WriteGuestConfig(ctx context.Context, vmid int, text string) error
	DestroyGuest(ctx context.Context, typ string, vmid int) error
	// MoveDisk moves a (running) VM's disk to storage and deletes the source.
	MoveDisk(ctx context.Context, vmid int, key, storage string, onProgress func(done, total int64)) error
}

// pveRuntime is the agent's Proxmox state.
type pveRuntime struct {
	backend pveBackend
	mu      sync.Mutex
	info    *ProxmoxAgentInfo
	infoAt  time.Time
	// Guests this agent currently holds a lock / snapshot on.
	busy map[int]bool
}

// newProxmoxRuntime picks the backend: the mock when AMBER_PROXMOX_MOCK names
// a directory, the real one on a PVE node, else none.
func newProxmoxRuntime() *pveRuntime {
	var b pveBackend
	if dir := os.Getenv("AMBER_PROXMOX_MOCK"); dir != "" {
		b = newMockPve(dir)
	} else {
		b = newRealPveBackend()
	}
	if b == nil {
		return nil
	}
	rt := &pveRuntime{backend: b, busy: map[int]bool{}}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := rt.agentInfo(ctx); err != nil {
		log.Printf("Proxmox VE (%s) not usable: %v", b.Name(), err)
		return nil
	}
	log.Printf("Proxmox VE support enabled (%s)", b.Name())
	return rt
}

// agentInfo is cached for five minutes (it goes into every poll).
func (rt *pveRuntime) agentInfo(ctx context.Context) (*ProxmoxAgentInfo, error) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.info != nil && time.Since(rt.infoAt) < 5*time.Minute {
		return rt.info, nil
	}
	info, err := rt.backend.Info(ctx)
	if err != nil {
		if rt.info != nil {
			return rt.info, nil
		}
		return nil, err
	}
	rt.info, rt.infoAt = info, time.Now()
	return info, nil
}

func (rt *pveRuntime) claim(vmid int) bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.busy[vmid] {
		return false
	}
	rt.busy[vmid] = true
	return true
}

func (rt *pveRuntime) release(vmid int) {
	rt.mu.Lock()
	delete(rt.busy, vmid)
	rt.mu.Unlock()
}

func (rt *pveRuntime) isBusy(vmid int) bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.busy[vmid]
}

// pveMountBase is where guest views are mounted; restic records the paths,
// so it must be the same on every node and every run.
func pveMountBase() string { return getenv("AMBER_PVE_MOUNT_BASE", "/run/amber-agent/pve") }

func pveGuestRoot(vmid int) string { return filepath.Join(pveMountBase(), strconv.Itoa(vmid)) }

// lockMarker records that Amber set a guest's `backup` lock, so a stale one
// can be removed after a crash without touching a lock vzdump holds.
func lockMarker(vmid int) string {
	return filepath.Join(installDir(), "proxmox", "locks", strconv.Itoa(vmid))
}

// --- Inventory -----------------------------------------------------------------

func (a *agent) runProxmoxInventory(ctx context.Context, t *Task) {
	if a.proxmox == nil {
		a.postResult(t.TaskID, TaskResult{Status: "failed", Error: "Proxmox VE is not available on this agent"})
		return
	}
	inv, err := a.proxmox.backend.Inventory(ctx)
	if err != nil {
		a.postResult(t.TaskID, TaskResult{Status: "failed", Error: err.Error()})
		return
	}
	a.postResult(t.TaskID, TaskResult{Status: "success", ProxmoxInventory: inv})
	log.Printf("Proxmox inventory %s: %d guests on %d nodes", t.TaskID, len(inv.Guests), len(inv.Nodes))
}

// buildGuest fills the config-derived fields of an inventory guest.
func buildGuest(g ProxmoxGuest, cfg *pveConfig, storages map[string]*pveStorageCfg) ProxmoxGuest {
	g.Disks = guestDisks(g.Type, cfg)
	if g.Disks == nil {
		g.Disks = []ProxmoxGuestDisk{}
	}
	if g.Tags == nil {
		g.Tags = []string{}
	}
	if g.Name == "" {
		if g.Type == pveTypeLXC {
			g.Name = cfg.Keys["hostname"]
		} else {
			g.Name = cfg.Keys["name"]
		}
	}
	if g.Lock == "" {
		g.Lock = cfg.Keys["lock"]
	}
	if cfg.Keys["template"] == "1" {
		g.Template = true
	}
	if g.Type == pveTypeQemu {
		ga := cfg.flag("agent")
		g.GuestAgent = &ga
	} else {
		up := cfg.Keys["unprivileged"] == "1"
		g.Unprivileged = &up
	}
	if n, err := strconv.Atoi(cfg.Keys["cores"]); err == nil {
		g.Cores = n
	}
	if n, err := strconv.ParseInt(cfg.Keys["memory"], 10, 64); err == nil {
		g.MemoryBytes = n << 20
	}
	g.AutoMethod, g.AutoMethodReason = resolveMethod(&g, "auto", storages)
	g.StaleSnapshots = staleAmberSnapshots(cfg)
	return g
}

// --- Backup --------------------------------------------------------------------

// pveBackupCtx carries one guest's backup.
type pveBackupCtx struct {
	a         *agent
	t         *Task
	px        *ProxmoxTask
	be        pveBackend
	self      string
	guest     ProxmoxGuest
	cfg       *pveConfig
	storages  map[string]*pveStorageCfg
	res       *ProxmoxGuestResult
	logf      func(format string, args ...any)
	appendLog func(string)
	started   time.Time
}

func (a *agent) runProxmoxBackup(ctx context.Context, t *Task) {
	var logBuf logBuffer
	appendLog := logBuf.appendLine
	logText := logBuf.String
	px := t.Proxmox
	if a.proxmox == nil || px == nil || px.Guest == nil {
		a.failTask(t, "Proxmox VE is not available on this agent", "")
		return
	}
	g := px.Guest
	res := &ProxmoxGuestResult{VMID: g.VMID, Type: g.Type, Name: g.Name, Node: g.Node, Status: "failed"}
	post := func() {
		if ctx.Err() != nil && res.Status != "success" {
			a.postResult(t.TaskID, TaskResult{Status: "cancelled", Log: logText(), ProxmoxGuest: res})
			return
		}
		status := "success"
		if res.Status == "failed" {
			status = "failed"
		}
		tr := TaskResult{Status: status, SnapshotID: res.SnapshotID, Error: res.Error, Log: logText(), ProxmoxGuest: res}
		tr.Stats = map[string]any{
			"dataAdded": res.DataAdded, "totalBytesProcessed": res.TotalBytes,
			"bytesRead": res.BytesRead, "totalDuration": res.DurationSeconds, "percentDone": 1,
			"filesNew": res.filesNew, "filesChanged": res.filesChanged, "filesUnmodified": res.filesUnmodified,
		}
		a.postResult(t.TaskID, tr)
		log.Printf("proxmox-backup %s (vmid %d): %s %s", t.TaskID, g.VMID, res.Status, res.Error)
	}

	info, err := a.proxmox.agentInfo(ctx)
	if err != nil {
		res.Error = "reading the node: " + err.Error()
		post()
		return
	}
	res.Node = info.Node

	// The guest must be on this node — it may have migrated since the server
	// planned the run.
	node, typ, err := a.proxmox.backend.LocateGuest(ctx, g.VMID)
	switch {
	case errors.Is(err, errGuestNotFound):
		res.Status, res.Error = "skipped", "The guest no longer exists"
		post()
		return
	case err != nil:
		res.Error = "locating the guest: " + err.Error()
		post()
		return
	case node != info.Node:
		res.Status, res.MovedTo, res.Node = "moved", node, node
		appendLog(fmt.Sprintf("guest %d is on node %s now, not %s", g.VMID, node, info.Node))
		post()
		return
	}
	if typ != g.Type {
		res.Type = typ
	}
	if !a.proxmox.claim(g.VMID) {
		res.Error = "another Amber task is backing up this guest right now"
		post()
		return
	}
	defer a.proxmox.release(g.VMID)

	env := append(scriptEnv(t, "pre", "", "", ""), pveScriptEnv(res)...)
	if t.Options != nil && t.Options.PreScript != "" {
		appendLog("[pre-script] " + t.Options.PreScript)
		if err := runScriptLogged(t.Options.PreScript, env, appendLog); err != nil {
			res.Error = "pre-script: " + err.Error()
			a.pvePostScript(t, res, appendLog)
			post()
			return
		}
	}
	if err := a.runner.ensureInitialized(ctx, t, appendLog); err != nil {
		res.Error = err.Error()
	} else {
		a.backupGuest(ctx, t, res, appendLog)
	}
	a.pvePostScript(t, res, appendLog)
	post()
}

func pveScriptEnv(res *ProxmoxGuestResult) []string {
	return []string{
		"AMBER_PVE_VMID=" + strconv.Itoa(res.VMID),
		"AMBER_PVE_TYPE=" + res.Type,
		"AMBER_PVE_NODE=" + res.Node,
	}
}

func (a *agent) pvePostScript(t *Task, res *ProxmoxGuestResult, appendLog func(string)) {
	if t.Options == nil {
		return
	}
	script, hook, status := t.Options.PostSuccessScript, "post-success", "success"
	if res.Status != "success" {
		script, hook, status = t.Options.PostFailureScript, "post-failure", "failed"
	}
	if script == "" {
		return
	}
	appendLog("[" + hook + "-script] " + script)
	env := append(scriptEnv(t, hook, status, res.SnapshotID, res.Error), pveScriptEnv(res)...)
	if err := runScriptLogged(script, env, appendLog); err != nil {
		appendLog("[" + hook + "-script] " + err.Error())
	}
}

// backupGuest prepares (stale cleanup, method) and runs one guest's backup.
func (a *agent) backupGuest(ctx context.Context, t *Task, res *ProxmoxGuestResult, appendLog func(string)) {
	be := a.proxmox.backend
	px := t.Proxmox
	b := &pveBackupCtx{a: a, t: t, px: px, be: be, self: res.Node, res: res, appendLog: appendLog, started: time.Now()}
	b.logf = func(format string, args ...any) {
		appendLog(fmt.Sprintf("[%d] ", res.VMID) + fmt.Sprintf(format, args...))
	}
	defer func() { res.DurationSeconds = time.Since(b.started).Seconds() }()

	cfg, err := be.GuestConfig(ctx, res.Type, res.VMID)
	if err != nil {
		res.Error = "reading the guest config: " + err.Error()
		return
	}
	storages, err := be.Storages(ctx)
	if err != nil {
		res.Error = "reading storage.cfg: " + err.Error()
		return
	}
	b.storages = storages
	b.cleanupStale(ctx, cfg)
	if cfg, err = be.GuestConfig(ctx, res.Type, res.VMID); err != nil {
		res.Error = "reading the guest config: " + err.Error()
		return
	}
	b.cfg = cfg
	status, err := be.GuestStatus(ctx, res.Type, res.VMID)
	if err != nil {
		res.Error = "reading the guest status: " + err.Error()
		return
	}
	b.guest = buildGuest(ProxmoxGuest{VMID: res.VMID, Type: res.Type, Name: res.Name, Node: res.Node, Status: status}, cfg, storages)
	if b.guest.Name != "" {
		res.Name = b.guest.Name
	}
	if l := cfg.Keys["lock"]; l != "" {
		res.Error = fmt.Sprintf("the guest is locked (%s)", l)
		return
	}

	choice := px.VMMethod
	if res.Type == pveTypeLXC {
		choice = px.CTMethod
	}
	method, reason := resolveMethod(&b.guest, choice, storages)
	res.Method = method
	if reason != "" && method == pveMethodVzdump && choice != pveMethodVzdump {
		b.logf("using vzdump: %s", reason)
		res.Warnings = append(res.Warnings, "vzdump fallback: "+reason)
	}
	running := status == "running"
	if px.RequireConsistent && res.Type == pveTypeQemu && running && !boolVal(b.guest.GuestAgent) {
		res.Error = "the VM runs without the QEMU guest agent, so no consistent backup is possible (the job requires one)"
		return
	}
	switch method {
	case pveMethodBlock:
		err = b.backupBlock(ctx, running)
	case pveMethodFiles:
		err = b.backupFiles(ctx, running)
	default:
		err = b.backupVzdump(ctx, running)
	}
	if ctx.Err() != nil {
		res.Error = "cancelled"
		return
	}
	if err != nil {
		res.Error = err.Error()
		b.logf("%s", res.Error)
		return
	}
	res.Status = "success"
	b.logf("snapshot %s (%s, %s)", res.SnapshotID, res.Method, res.Consistency)
}

func boolVal(b *bool) bool { return b != nil && *b }

// cleanupStale removes what a crashed Amber run left on the guest: amber-*
// snapshots and a backup lock Amber itself set.
func (b *pveBackupCtx) cleanupStale(ctx context.Context, cfg *pveConfig) {
	vmid := b.res.VMID
	if cfg.Keys["lock"] == "backup" && fileExists(lockMarker(vmid)) {
		b.logf("removing the backup lock a previous Amber run left")
		if err := b.be.SetLock(ctx, b.res.Type, vmid, ""); err != nil {
			b.logf("could not unlock: %v", err)
		} else {
			os.Remove(lockMarker(vmid))
		}
	}
	for _, s := range staleAmberSnapshots(cfg) {
		b.logf("removing stale snapshot %s", s)
		if err := b.be.DeleteSnapshot(ctx, b.res.Type, vmid, s); err != nil {
			b.logf("could not remove snapshot %s: %v", s, err)
		}
	}
	cleanupMountsBelow(pveGuestRoot(vmid))
}

// resticBackupArgs are the shared flags of a guest backup.
func (b *pveBackupCtx) resticBackupArgs() []string {
	slug := b.px.ClusterSlug
	args := []string{"backup", "--json", "--host", pveResticHost(slug),
		"--tag", proxmoxSnapshotTag, "--tag", pveClusterTag(slug),
		"--tag", pveGuestTag(b.res.VMID), "--tag", "pve-type:" + b.res.Type}
	if o := b.t.Options; o != nil {
		for _, tag := range o.Tags {
			args = append(args, "--tag", tag)
		}
		if o.Compression != "" {
			args = append(args, "--compression", o.Compression)
		}
		if o.ReadConcurrency > 0 {
			args = append(args, "--read-concurrency", strconv.Itoa(o.ReadConcurrency))
		}
	}
	return args
}

// runResticBackup runs restic, forwarding progress and filling the result.
func (b *pveBackupCtx) runResticBackup(ctx context.Context, args []string, bytesRead func() int64) error {
	var last time.Time
	var summary map[string]any
	code, failure, err := b.a.runner.runCapture(ctx, b.t, args, func(msg map[string]any) {
		switch msg["message_type"] {
		case "status":
			if time.Since(last) > time.Second {
				last = time.Now()
				p := map[string]any{
					"percentDone": msg["percent_done"], "bytesDone": msg["bytes_done"],
					"totalBytes": msg["total_bytes"], "filesDone": msg["files_done"],
					"totalFiles": msg["total_files"], "vmid": b.res.VMID,
				}
				if bytesRead != nil {
					p["bytesRead"] = bytesRead()
				}
				b.a.postProgress(b.t.TaskID, p)
			}
		case "summary":
			summary = msg
		}
	}, b.appendLog)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if summary != nil {
		b.res.SnapshotID, _ = summary["snapshot_id"].(string)
		b.res.DataAdded = jsonNum(summary, "data_added")
		b.res.TotalBytes = jsonNum(summary, "total_bytes_processed")
		b.res.filesNew = jsonNum(summary, "files_new")
		b.res.filesChanged = jsonNum(summary, "files_changed")
		b.res.filesUnmodified = jsonNum(summary, "files_unmodified")
	}
	// Exit 3 (some files unreadable) is a failure for a guest backup.
	if err != nil || code != 0 || b.res.SnapshotID == "" {
		return resticError("restic backup", code, err, failure)
	}
	return nil
}

// consistencyOf describes a backup of a guest in the given state.
func (b *pveBackupCtx) consistencyOf(running bool, stopMode bool) string {
	if !running || stopMode {
		return "offline"
	}
	if b.res.Type == pveTypeQemu && boolVal(b.guest.GuestAgent) {
		return "application"
	}
	return "crash"
}

// --- vzdump method -------------------------------------------------------------

func vzdumpFileName(typ string, vmid int) string {
	ext := "vma"
	if typ == pveTypeLXC {
		ext = "tar"
	}
	return fmt.Sprintf("vzdump-%s-%d.%s", typ, vmid, ext)
}

func (b *pveBackupCtx) backupVzdump(ctx context.Context, running bool) error {
	mode := b.px.VzdumpMode
	if mode == "" {
		mode = "snapshot"
	}
	argv, err := b.be.VzdumpCommand(ctx, b.res.Type, b.res.VMID, mode)
	if err != nil {
		return err
	}
	b.res.Consistency = b.consistencyOf(running, mode == "stop")
	b.logf("vzdump (mode %s) streamed into restic", mode)
	args := append(b.resticBackupArgs(), "--stdin-from-command", "--stdin-filename", vzdumpFileName(b.res.Type, b.res.VMID), "--")
	args = append(args, argv...)
	if err := b.runResticBackup(ctx, args, nil); err != nil {
		return err
	}
	b.res.BytesRead = b.res.TotalBytes
	b.res.NextCbt = nil
	return nil
}

// --- shared snapshot handling (block, files) -----------------------------------

// takeSnapshot creates the PVE snapshot and the backup lock; the returned
// func removes both, whatever happened.
func (b *pveBackupCtx) takeSnapshot(ctx context.Context) (string, func(), error) {
	vmid := b.res.VMID
	snap := pveSnapshotPrefix + pveShortID(b.t.TaskID)
	b.logf("creating snapshot %s", snap)
	// ASSUMPTION(pve): `qm snapshot <vmid> <name> --vmstate 0` freezes the guest
	// filesystems through the guest agent when it is enabled; `pct snapshot`
	// freezes the container while the storage snapshot is taken.
	if err := b.be.Snapshot(ctx, b.res.Type, vmid, snap); err != nil {
		return "", nil, fmt.Errorf("snapshot failed: %w", err)
	}
	locked := false
	os.MkdirAll(filepath.Dir(lockMarker(vmid)), 0o700)
	os.WriteFile(lockMarker(vmid), []byte(b.t.TaskID), 0o600)
	// ASSUMPTION(pve): `qm set --lock backup` / `pct set --lock backup` keeps PVE
	// from migrating, removing or snapshotting the guest until unlocked.
	if err := b.be.SetLock(ctx, b.res.Type, vmid, "backup"); err != nil {
		b.logf("could not lock the guest (continuing): %v", err)
		os.Remove(lockMarker(vmid))
	} else {
		locked = true
	}
	return snap, func() {
		cctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if locked {
			if err := b.be.SetLock(cctx, b.res.Type, vmid, ""); err != nil {
				b.logf("unlocking failed: %v", err)
			} else {
				os.Remove(lockMarker(vmid))
			}
		}
		if err := b.be.DeleteSnapshot(cctx, b.res.Type, vmid, snap); err != nil {
			b.logf("removing snapshot %s failed: %v", snap, err)
		} else {
			b.logf("snapshot %s removed", snap)
		}
	}, nil
}

// pveManifest is stored with every block/files snapshot.
type pveManifest struct {
	Format       int                `json:"format"`
	Method       string             `json:"method"`
	VMID         int                `json:"vmid"`
	Type         string             `json:"type"`
	Name         string             `json:"name"`
	Node         string             `json:"node"`
	Cluster      string             `json:"cluster"`
	BackedUpAt   string             `json:"backedUpAt"`
	Consistency  string             `json:"consistency"`
	SegmentBytes int64              `json:"segmentBytes,omitempty"`
	Disks        []ProxmoxGuestDisk `json:"disks"`
	// Real disk sizes as read from the snapshot (block).
	DiskSizes map[string]int64 `json:"diskSizes,omitempty"`
	// Mount paths of the CT volumes (files).
	MountPaths map[string]string `json:"mountPaths,omitempty"`
	IDMap      []idMapEntry      `json:"idmap,omitempty"`
	Config     string            `json:"config"`
	Cbt        string            `json:"cbt,omitempty"`
}

func (b *pveBackupCtx) manifest(method, consistency string) pveManifest {
	return pveManifest{
		Format: pveManifestFormat, Method: method, VMID: b.res.VMID, Type: b.res.Type,
		Name: b.res.Name, Node: b.self, Cluster: b.px.ClusterSlug,
		BackedUpAt: time.Now().UTC().Format(time.RFC3339), Consistency: consistency,
		Config: b.cfg.currentConfigText(),
	}
}

// --- block method --------------------------------------------------------------

// bitmapName is unique per job and run: two jobs never share a bitmap.
func (b *pveBackupCtx) bitmapName() string {
	return pveSnapshotPrefix + pveShortID(b.t.JobID) + "-" + pveShortID(b.t.TaskID)
}

// pveShortID is a 12-hex-digit digest of an id: PVE snapshot names are short
// (≤ 40 chars) and must stay unique per run item.
func pveShortID(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:6])
}

func (b *pveBackupCtx) backupBlock(ctx context.Context, running bool) error {
	vmid := b.res.VMID
	var disks []ProxmoxGuestDisk
	var keys []string
	for _, d := range b.guest.Disks {
		if d.Backup {
			disks = append(disks, d)
			keys = append(keys, d.Key)
		}
	}
	b.res.Consistency = b.consistencyOf(running, false)

	// The new bitmap must exist before the snapshot: it then covers every
	// write after it, which the next run reads.
	newBitmap := ""
	if running {
		name := b.bitmapName()
		if err := b.be.AddBitmaps(ctx, vmid, keys, name); err != nil {
			b.logf("change tracking unavailable (next run reads everything): %v", err)
			b.res.Warnings = append(b.res.Warnings, "dirty bitmap: "+err.Error())
		} else {
			newBitmap = name
		}
	}
	success := false
	defer func() {
		cctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if newBitmap != "" && !success {
			b.be.RemoveBitmaps(cctx, vmid, keys, newBitmap)
		}
		// The previous bitmap is done with once this run succeeded.
		if success && b.px.Cbt != nil && b.px.Cbt.Node == b.self && b.px.Cbt.Bitmap != newBitmap {
			if err := b.be.RemoveBitmaps(cctx, vmid, keys, b.px.Cbt.Bitmap); err != nil && !errors.Is(err, errNoBitmap) {
				b.logf("removing the previous bitmap failed: %v", err)
			}
		}
	}()

	snap, release, err := b.takeSnapshot(ctx)
	if err != nil {
		return err
	}
	defer release()

	readers := map[string]pveDiskReader{}
	defer func() {
		for _, r := range readers {
			r.Close()
		}
	}()
	sizes := map[string]int64{}
	for _, d := range disks {
		r, err := b.be.OpenSnapshotDisk(ctx, vmid, d, b.storages[d.Storage], snap)
		if err != nil {
			return fmt.Errorf("opening the snapshot of %s: %w", d.Key, err)
		}
		readers[d.Key] = r
		sizes[d.Key] = r.Size()
	}

	root := pveGuestRoot(vmid)
	dirty, reason := b.changedSegments(ctx, running, disks, sizes)
	var parent map[string]segParentInfo
	if dirty != nil {
		parent, err = b.a.snapshotFileTimes(ctx, b.t, b.px.ParentSnapshotID, root+"/disks/")
		if err != nil {
			dirty, reason = nil, "the parent snapshot can't be read: "+err.Error()
		}
	}
	if dirty == nil {
		b.res.Cbt, b.res.CbtReason = "full", reason
		b.logf("reading every segment: %s", reason)
	} else {
		b.res.Cbt = "incremental"
	}

	now := time.Now()
	view := &segmentView{SegBytes: pveSegmentBytes, Now: now, Files: map[string][]byte{}}
	var toRead int64
	for _, d := range disks {
		var dmap map[int64]bool
		if dirty != nil {
			dmap = dirty[d.Key]
			if dmap == nil {
				dmap = map[int64]bool{}
			}
		}
		mt, n := planSegmentMtimes(root, d.Key, sizes[d.Key], pveSegmentBytes, dmap, parent, now)
		toRead += n
		view.Disks = append(view.Disks, &segDisk{Key: d.Key, Size: sizes[d.Key], Reader: readers[d.Key], Mtimes: mt})
	}
	sort.Slice(view.Disks, func(i, j int) bool { return view.Disks[i].Key < view.Disks[j].Key })
	b.logf("%d segments to read (%s)", toRead, b.res.Cbt)

	m := b.manifest(pveMethodBlock, b.res.Consistency)
	m.SegmentBytes, m.Disks, m.DiskSizes, m.Cbt = pveSegmentBytes, disks, sizes, b.res.Cbt
	mdata, _ := json.MarshalIndent(m, "", "  ")
	view.Files[pveManifestName] = mdata
	view.Files["qemu-server.conf"] = []byte(m.Config)

	cleanupMountsBelow(root)
	unmount, err := mountSegmentView(root, view)
	if err != nil {
		return err
	}
	defer func() {
		if err := unmount(); err != nil {
			b.logf("unmounting the segment view: %v", err)
		}
		os.Remove(root)
	}()

	args := b.resticBackupArgs()
	args = append(args, "--ignore-inode", "--ignore-ctime")
	if b.px.ParentSnapshotID != "" {
		args = append(args, "--parent", b.px.ParentSnapshotID)
	}
	args = append(args, "--", root)
	if err := b.runResticBackup(ctx, args, view.BytesRead.Load); err != nil {
		return err
	}
	b.res.BytesRead = float64(view.BytesRead.Load())
	if newBitmap != "" {
		cbt := &ProxmoxCbtState{Bitmap: newBitmap, Node: b.self, SegmentBytes: pveSegmentBytes}
		for _, d := range disks {
			cbt.Disks = append(cbt.Disks, ProxmoxCbtDisk{Key: d.Key, SizeBytes: sizes[d.Key]})
		}
		b.res.NextCbt = cbt
	}
	success = true
	return nil
}

// changedSegments reads the previous run's bitmaps: the segments each disk
// changed in since then, or nil and why a full read is needed.
func (b *pveBackupCtx) changedSegments(ctx context.Context, running bool, disks []ProxmoxGuestDisk, sizes map[string]int64) (map[string]map[int64]bool, string) {
	c := b.px.Cbt
	switch {
	case b.px.ParentSnapshotID == "":
		return nil, "first backup of this guest in this job"
	case c == nil:
		return nil, "no change tracking from the previous backup"
	case !running:
		return nil, "the VM is not running (dirty bitmaps live in QEMU)"
	case c.Node != b.self:
		return nil, "the VM was backed up on node " + c.Node + " last time"
	case c.SegmentBytes != pveSegmentBytes:
		return nil, "the segment size changed"
	}
	prev := map[string]int64{}
	for _, d := range c.Disks {
		prev[d.Key] = d.SizeBytes
	}
	if len(prev) != len(disks) {
		return nil, "the VM's disks changed"
	}
	out := map[string]map[int64]bool{}
	for _, d := range disks {
		size, ok := prev[d.Key]
		if !ok || size != sizes[d.Key] {
			return nil, "disk " + d.Key + " was added or resized"
		}
		ext, err := b.be.DirtyExtents(ctx, b.res.VMID, d.Key, c.Bitmap)
		if err != nil {
			return nil, "reading the dirty bitmap of " + d.Key + ": " + err.Error()
		}
		out[d.Key] = dirtySegments(ext, sizes[d.Key], pveSegmentBytes)
	}
	return out, ""
}

// --- files method (containers) -------------------------------------------------

// vzdumpDefaultExcludes are vzdump's default CT excludes (below the CT root).
var vzdumpDefaultExcludes = []string{"/tmp/?*", "/var/tmp/?*", "/var/run/?*.pid"}

func (b *pveBackupCtx) backupFiles(ctx context.Context, running bool) error {
	vmid := b.res.VMID
	b.res.Consistency = b.consistencyOf(running, false)
	var vols []ProxmoxGuestDisk
	for _, d := range b.guest.Disks {
		if !d.Backup {
			continue
		}
		if d.Storage == "" {
			b.logf("skipping bind mount %s (%s)", d.Key, d.MountPath)
			continue
		}
		vols = append(vols, d)
	}
	// Parents before children: rootfs, then mount points by depth.
	sort.SliceStable(vols, func(i, j int) bool {
		return strings.Count(strings.TrimRight(vols[i].MountPath, "/"), "/") < strings.Count(strings.TrimRight(vols[j].MountPath, "/"), "/") ||
			vols[i].MountPath == "/"
	})

	snap, release, err := b.takeSnapshot(ctx)
	if err != nil {
		return err
	}
	defer release()

	root := pveGuestRoot(vmid)
	cleanupMountsBelow(root)
	os.RemoveAll(root)
	ctRoot := filepath.Join(root, "root")
	if err := os.MkdirAll(ctRoot, 0o700); err != nil {
		return err
	}
	var unmounts []func() error
	defer func() {
		for i := len(unmounts) - 1; i >= 0; i-- {
			if err := unmounts[i](); err != nil {
				b.logf("unmounting: %v", err)
			}
		}
		os.RemoveAll(root)
	}()
	m := b.manifest(pveMethodFiles, b.res.Consistency)
	m.Disks, m.MountPaths, m.IDMap = vols, map[string]string{}, ctIDMap(b.cfg)
	for _, v := range vols {
		target := filepath.Join(ctRoot, filepath.FromSlash(strings.TrimPrefix(v.MountPath, "/")))
		if err := os.MkdirAll(target, 0o700); err != nil {
			return err
		}
		un, err := b.be.MountSnapshotVolume(ctx, vmid, v, b.storages[v.Storage], snap, target)
		if err != nil {
			return fmt.Errorf("mounting the snapshot of %s: %w", v.Key, err)
		}
		unmounts = append(unmounts, un)
		m.MountPaths[v.Key] = v.MountPath
	}
	mdata, _ := json.MarshalIndent(m, "", "  ")
	if err := os.WriteFile(filepath.Join(root, pveManifestName), mdata, 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(root, "lxc.conf"), []byte(m.Config), 0o600); err != nil {
		return err
	}

	args := b.resticBackupArgs()
	for _, e := range vzdumpDefaultExcludes {
		args = append(args, "--exclude", ctRoot+e)
	}
	if o := b.t.Options; o != nil {
		for _, e := range o.Exclude {
			if strings.HasPrefix(e, "/") {
				e = ctRoot + e
			}
			args = append(args, "--exclude", e)
		}
	}
	if b.px.ParentSnapshotID != "" {
		args = append(args, "--parent", b.px.ParentSnapshotID)
	}
	args = append(args, "--", root)
	if err := b.runResticBackup(ctx, args, nil); err != nil {
		return err
	}
	b.res.BytesRead = b.res.TotalBytes
	return nil
}

// --- Retention -----------------------------------------------------------------

// proxmoxForgetArgs keeps each guest's snapshots apart: all carry the cluster's
// host, and grouping by host and tags separates them by pve-guest.
func proxmoxForgetArgs(slug string) func(*Retention) []string {
	return func(ret *Retention) []string {
		args := forgetArgs(ret)
		return append(args, "--host", pveResticHost(slug), "--tag", proxmoxSnapshotTag+","+pveClusterTag(slug),
			"--group-by", "host,tags")
	}
}

func (a *agent) runProxmoxRetention(ctx context.Context, t *Task) {
	var logBuf logBuffer
	appendLog := logBuf.appendLine
	result := TaskResult{Status: "success"}
	slug := ""
	if t.Proxmox != nil {
		slug = t.Proxmox.ClusterSlug
	}
	if t.Options != nil && hasRetention(t.Options.Retention) && slug != "" {
		code, failure, err := a.runner.runCapture(ctx, t, proxmoxForgetArgs(slug)(t.Options.Retention), func(msg map[string]any) {}, appendLog)
		if ctx.Err() != nil {
			a.cancelTask(t, logBuf.String())
			return
		}
		if err != nil || code != 0 {
			a.failTask(t, resticError("forget", code, err, failure).Error(), logBuf.String())
			return
		}
		if t.Options.Retention.Prune {
			result.Prune = a.runPrune(ctx, t)
		}
	}
	if ctx.Err() != nil {
		a.cancelTask(t, logBuf.String())
		return
	}
	a.readRepoStats(ctx, t, &result)
	result.Log = logBuf.String()
	a.postResult(t.TaskID, result)
	log.Printf("proxmox-retention %s done", t.TaskID)
}
