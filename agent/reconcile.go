package main

// Start-up reconciliation: when the agent was killed mid-task (SIGKILL, OOM,
// host reboot) nothing of its own cleanup ran. Before it takes new work it
// removes what such a run left behind: per-run directories holding plaintext
// credential files, FUSE mounts of guest views, and the backup locks and
// amber-* snapshots it had put on Proxmox guests.

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

// staleTempRE matches what the agent creates in its temp directory per run
// (os.MkdirTemp / os.CreateTemp append decimal digits). The restic cache
// (amber-restic-cache) does not match.
var staleTempRE = regexp.MustCompile(`^(amber-restic-|amber-nbd-|amber-hv-)[0-9]+(\.ps1)?$`)

// Retries of the Proxmox lock cleanup while PVE is not ready yet (at boot the
// cluster filesystem may come up after the agent).
var (
	staleLockAttempts = 10
	staleLockRetry    = 30 * time.Second
)

func (a *agent) reconcileOnStart() {
	if mps := cleanupMountsBelow(pveMountBase()); len(mps) > 0 {
		log.Printf("unmounted %d stale guest view(s) a previous run left: %v", len(mps), mps)
	}
	dir := tempBaseDir()
	if dir == "" {
		dir = os.TempDir()
	}
	if n := removeStaleTemp(dir); n > 0 {
		log.Printf("removed %d stale per-run temp item(s) from %s", n, dir)
	}
	if a.proxmox != nil {
		go a.proxmox.releaseStaleLocksLoop(a.context())
	}
}

// removeStaleTemp deletes the agent's per-run temp items in dir and returns
// how many it removed.
func removeStaleTemp(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if !staleTempRE.MatchString(e.Name()) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil {
			log.Printf("cannot remove stale %s: %v", e.Name(), err)
			continue
		}
		n++
	}
	return n
}

// releaseStaleLocksLoop retries releaseStaleLocks until every marker is dealt
// with, the attempts are used up or ctx ends.
func (rt *pveRuntime) releaseStaleLocksLoop(ctx context.Context) {
	for i := 0; i < staleLockAttempts && ctx.Err() == nil; i++ {
		cctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		left := rt.releaseStaleLocks(cctx)
		cancel()
		if left == 0 {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(staleLockRetry):
		}
	}
}

// releaseStaleLocks works through the lock markers of guests Amber locked:
// it removes the `backup` lock and the amber-* snapshots a killed run left
// and then the marker. It returns how many markers it could not settle yet
// (PVE not reachable); a guest that is gone or now on another node only
// loses its marker or is left to that node's next backup.
func (rt *pveRuntime) releaseStaleLocks(ctx context.Context) int {
	dir := filepath.Dir(lockMarker(0))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	info, err := rt.agentInfo(ctx)
	if err != nil {
		log.Printf("stale Proxmox locks: cannot read the node: %v", err)
		return len(entries)
	}
	be := rt.backend
	left := 0
	for _, e := range entries {
		vmid, err := strconv.Atoi(e.Name())
		if err != nil || e.IsDir() {
			continue
		}
		// A backup of this guest that already started cleans up itself.
		if !rt.claim(vmid) {
			continue
		}
		ok := rt.releaseStaleLock(ctx, be, info.Node, vmid)
		rt.release(vmid)
		if !ok {
			left++
		}
	}
	return left
}

// releaseStaleLock settles one marker; false when it should be retried.
func (rt *pveRuntime) releaseStaleLock(ctx context.Context, be pveBackend, self string, vmid int) bool {
	marker := lockMarker(vmid)
	node, typ, err := be.LocateGuest(ctx, vmid)
	switch {
	case errors.Is(err, errGuestNotFound):
		os.Remove(marker)
		return true
	case err != nil:
		log.Printf("stale Proxmox lock of guest %d: %v (will retry)", vmid, err)
		return false
	case node != self:
		// Only the owning node can unlock it; this marker is of no use here.
		log.Printf("guest %d carries a stale Amber lock marker but is on node %s now; unlock it there (qm/pct unlock %d)", vmid, node, vmid)
		os.Remove(marker)
		return true
	}
	cfg, err := be.GuestConfig(ctx, typ, vmid)
	if err != nil {
		log.Printf("stale Proxmox lock of guest %d: %v (will retry)", vmid, err)
		return false
	}
	if cfg.Keys["lock"] == "backup" {
		if err := be.SetLock(ctx, typ, vmid, ""); err != nil {
			log.Printf("could not remove the stale backup lock of guest %d: %v (will retry)", vmid, err)
			return false
		}
		log.Printf("removed the backup lock a killed Amber run left on guest %d", vmid)
	}
	for _, s := range staleAmberSnapshots(cfg) {
		if err := be.DeleteSnapshot(ctx, typ, vmid, s); err != nil {
			log.Printf("could not remove stale snapshot %s of guest %d: %v", s, vmid, err)
		} else {
			log.Printf("removed stale snapshot %s of guest %d", s, vmid)
		}
	}
	os.Remove(marker)
	return true
}
