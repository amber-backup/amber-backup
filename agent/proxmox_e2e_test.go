package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// End to end against the simulated Proxmox cluster and a real restic, which
// AMBER_TEST_RESTIC must name (skipped otherwise):
//
//	AMBER_TEST_RESTIC=$(command -v restic) go test -run ProxmoxE2E ./...
//
// The block method needs FUSE (fusermount3 for an unprivileged test run); its
// part is skipped when the segment view can't be mounted.
func pveHarness(t *testing.T) (mock *mockPve, tmp string, run func(*Task) TaskResult) {
	t.Helper()
	restic := os.Getenv("AMBER_TEST_RESTIC")
	if restic == "" {
		t.Skip("AMBER_TEST_RESTIC not set")
	}
	tmp = t.TempDir()
	t.Setenv("INSTALL_DIR", filepath.Join(tmp, "install"))
	t.Setenv("AMBER_PVE_MOUNT_BASE", filepath.Join(tmp, "mnt"))
	mock = newMockPve(filepath.Join(tmp, "cluster"))

	results := map[string]TaskResult{}
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/state"):
			w.Write([]byte(`{"cancelled":false}`))
		case strings.HasSuffix(r.URL.Path, "/result"):
			body, _ := io.ReadAll(r.Body)
			var res TaskResult
			if err := json.Unmarshal(body, &res); err != nil {
				t.Errorf("bad result: %v", err)
			}
			id := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/agents/me/tasks/"), "/")[0]
			mu.Lock()
			results[id] = res
			mu.Unlock()
		}
	}))
	t.Cleanup(srv.Close)

	a := &agent{
		baseURL: srv.URL, http: srv.Client(),
		proxmox: &pveRuntime{backend: mock, busy: map[int]bool{}},
		runner:  &resticRunner{binary: restic, cacheDir: filepath.Join(tmp, "cache"), stopGrace: defaultStopGrace},
	}
	run = func(task *Task) TaskResult {
		t.Helper()
		task.Repository = filepath.Join(tmp, "repo")
		task.Password = "secret"
		a.runTask(task)
		mu.Lock()
		defer mu.Unlock()
		res, ok := results[task.TaskID]
		if !ok {
			t.Fatalf("no result for %s", task.TaskID)
		}
		return res
	}
	return mock, tmp, run
}

func backupTask(id string, vmid int, typ, node string, parent string, cbt *ProxmoxCbtState) *Task {
	return &Task{Type: "proxmox-backup", TaskID: id, JobID: "11111111-2222-3333-4444-555555555555", JobName: "pve",
		Proxmox: &ProxmoxTask{ClusterID: "cluster-uuid", ClusterSlug: "lab",
			Guest:    &ProxmoxGuestRef{VMID: vmid, Type: typ, Node: node},
			VMMethod: "auto", CTMethod: "auto", ParentSnapshotID: parent, Cbt: cbt}}
}

func restoreTask(id, snapshot string, spec ProxmoxRestoreSpec) *Task {
	spec.ClusterID = "cluster-uuid"
	return &Task{Type: "proxmox-restore", TaskID: id, SnapshotID: snapshot, TargetPath: "/",
		Proxmox: &ProxmoxTask{ClusterID: "cluster-uuid", ClusterSlug: "lab", Restore: &spec}}
}

func guestOK(t *testing.T, r TaskResult) *ProxmoxGuestResult {
	t.Helper()
	if r.Status != "success" || r.ProxmoxGuest == nil || r.ProxmoxGuest.Status != "success" {
		t.Fatalf("backup failed: %+v %+v\n%s", r, r.ProxmoxGuest, r.Log)
	}
	return r.ProxmoxGuest
}

func TestProxmoxE2EInventoryMovedVzdump(t *testing.T) {
	mock, _, run := pveHarness(t)

	inv := run(&Task{Type: "proxmox-inventory", TaskID: "pveinv-c1", Proxmox: &ProxmoxTask{ClusterSlug: "lab"}})
	if inv.Status != "success" || inv.ProxmoxInventory == nil || len(inv.ProxmoxInventory.Guests) != 4 {
		t.Fatalf("inventory: %+v", inv)
	}
	methods := map[int]string{}
	for _, g := range inv.ProxmoxInventory.Guests {
		methods[g.VMID] = g.AutoMethod
	}
	if methods[100] != pveMethodBlock || methods[101] != pveMethodFiles || methods[102] != pveMethodVzdump {
		t.Fatalf("auto methods %v", methods)
	}

	// A guest on another node comes back as moved.
	mv := run(backupTask("aaaaaaaa-0000-0000-0000-000000000001", 200, pveTypeQemu, "pve1", "", nil))
	if mv.ProxmoxGuest == nil || mv.ProxmoxGuest.Status != "moved" || mv.ProxmoxGuest.MovedTo != "pve2" {
		t.Fatalf("moved: %+v", mv.ProxmoxGuest)
	}
	// A guest that is gone is skipped.
	gone := run(backupTask("aaaaaaaa-0000-0000-0000-000000000002", 999, pveTypeQemu, "pve1", "", nil))
	if gone.ProxmoxGuest == nil || gone.ProxmoxGuest.Status != "skipped" {
		t.Fatalf("missing guest: %+v", gone.ProxmoxGuest)
	}

	// VM 102 has a raw disk on dir storage → vzdump.
	r := guestOK(t, run(backupTask("aaaaaaaa-0000-0000-0000-000000000003", 102, pveTypeQemu, "pve1", "", nil)))
	if r.Method != pveMethodVzdump || r.Consistency != "offline" || r.SnapshotID == "" {
		t.Fatalf("vzdump result %+v", r)
	}
	rs := run(restoreTask("bbbbbbbb-0000-0000-0000-000000000001", r.SnapshotID,
		ProxmoxRestoreSpec{VMID: 102, GuestType: pveTypeQemu, Action: "guest", TargetNode: "pve1", Storage: "local-zfs", Name: "legacy-copy"}))
	if rs.Status != "success" {
		t.Fatalf("restore: %+v\n%s", rs, rs.Log)
	}
	orig, _ := os.ReadFile(mock.diskPath(102, "virtio0"))
	got, err := os.ReadFile(mock.diskPath(300, "virtio0"))
	if err != nil || !bytes.Equal(orig, got) {
		t.Fatalf("restored disk differs (%v)", err)
	}
	cfg, _ := mock.GuestConfig(nil, pveTypeQemu, 300)
	if cfg.Keys["name"] != "legacy-copy" || !strings.HasPrefix(cfg.Keys["virtio0"], "local-zfs:vm-300-disk-0") {
		t.Fatalf("restored config %v", cfg.Keys)
	}
	// Restoring onto an existing VMID without replace is refused.
	rs = run(restoreTask("bbbbbbbb-0000-0000-0000-000000000002", r.SnapshotID,
		ProxmoxRestoreSpec{VMID: 102, GuestType: pveTypeQemu, Action: "guest", TargetNode: "pve1", NewVMID: 100}))
	if rs.Status != "failed" || !strings.Contains(rs.Error, "already in use") {
		t.Fatalf("restore over a used VMID: %+v", rs)
	}

	// Retention keeps one snapshot per guest and reports the repository.
	ret := run(&Task{Type: "proxmox-retention", TaskID: "pveret-run1",
		Options: &ResticOptions{Retention: &Retention{KeepLast: ptr(1)}}, Proxmox: &ProxmoxTask{ClusterSlug: "lab"}})
	if ret.Status != "success" || ret.RepoStats == nil || ret.RepoStats.SnapshotCount != 1 {
		t.Fatalf("retention: %+v\n%s", ret, ret.Log)
	}
	// Without retention rules only the figures are read.
	ret = run(&Task{Type: "proxmox-retention", TaskID: "pveret-run2", Proxmox: &ProxmoxTask{ClusterSlug: "lab"}})
	if ret.Status != "success" || ret.RepoStats == nil {
		t.Fatalf("stats-only retention: %+v", ret)
	}
}

func TestProxmoxE2EBlockIncremental(t *testing.T) {
	mock, _, run := pveHarness(t)

	first := run(backupTask("cccccccc-0000-0000-0000-000000000001", 100, pveTypeQemu, "pve1", "", nil))
	if first.ProxmoxGuest != nil && strings.Contains(first.ProxmoxGuest.Error, "mounting the segment view") {
		t.Skipf("FUSE not available: %s", first.ProxmoxGuest.Error)
	}
	r1 := guestOK(t, first)
	if r1.Method != pveMethodBlock || r1.Cbt != "full" || r1.NextCbt == nil || r1.Consistency != "application" {
		t.Fatalf("first block backup %+v", r1)
	}
	// 40 MiB scsi0 (3 segments) + 1 MiB efidisk (1 segment) read in full.
	if r1.BytesRead != float64(41<<20) {
		t.Fatalf("first run read %v bytes", r1.BytesRead)
	}
	st, _ := mock.read()
	g, _ := mock.guest(st, 100)
	if len(g.Snapshots) != 0 || g.Lock != "" || len(g.Bitmaps) != 1 {
		t.Fatalf("after the run: snapshots %v lock %q bitmaps %v", g.Snapshots, g.Lock, g.Bitmaps)
	}

	// Change 4 KiB in segment 1 of scsi0.
	if err := mock.WriteDisk(100, "scsi0", 20<<20, bytes.Repeat([]byte{0xAB}, 4096)); err != nil {
		t.Fatal(err)
	}
	second := run(backupTask("cccccccc-0000-0000-0000-000000000002", 100, pveTypeQemu, "pve1", r1.SnapshotID, r1.NextCbt))
	r2 := guestOK(t, second)
	if r2.Cbt != "incremental" {
		t.Fatalf("second run not incremental: %+v", r2)
	}
	if r2.BytesRead != float64(16<<20) {
		t.Fatalf("second run read %v bytes, want one segment", r2.BytesRead)
	}
	// restic re-read exactly one segment file (plus the manifest/config).
	if fc := second.Stats["filesChanged"].(float64); fc > 3 {
		t.Fatalf("files changed %v", fc)
	}
	st, _ = mock.read()
	g, _ = mock.guest(st, 100)
	if _, ok := g.Bitmaps[r1.NextCbt.Bitmap]; ok || len(g.Bitmaps) != 1 {
		t.Fatalf("old bitmap not replaced: %v", g.Bitmaps)
	}

	// Restore the incremental snapshot: the disks equal the VM's current ones.
	rs := run(restoreTask("dddddddd-0000-0000-0000-000000000001", r2.SnapshotID,
		ProxmoxRestoreSpec{VMID: 100, GuestType: pveTypeQemu, Action: "guest", TargetNode: "pve1", NewVMID: 150, Unique: true, Start: true}))
	if rs.Status != "success" {
		t.Fatalf("restore: %+v\n%s", rs, rs.Log)
	}
	for _, key := range []string{"scsi0", "efidisk0"} {
		want, _ := os.ReadFile(mock.diskPath(100, key))
		got, err := os.ReadFile(mock.diskPath(150, key))
		if err != nil || !bytes.Equal(want, got) {
			t.Fatalf("restored %s differs (%v)", key, err)
		}
	}
	if s, _ := mock.GuestStatus(nil, pveTypeQemu, 150); s != "running" {
		t.Fatalf("restored VM not started: %s", s)
	}

	// After a VM restart the bitmap is gone: a full read, with the reason.
	mock.StopGuest(nil, pveTypeQemu, 100)
	mock.StartGuest(nil, pveTypeQemu, 100)
	r3 := guestOK(t, run(backupTask("cccccccc-0000-0000-0000-000000000003", 100, pveTypeQemu, "pve1", r2.SnapshotID, r2.NextCbt)))
	if r3.Cbt != "full" || !strings.Contains(r3.CbtReason, "bitmap") {
		t.Fatalf("after restart: %+v", r3)
	}
	// A stopped VM is read in full and carries no change tracking forward.
	mock.StopGuest(nil, pveTypeQemu, 100)
	r4 := guestOK(t, run(backupTask("cccccccc-0000-0000-0000-000000000004", 100, pveTypeQemu, "pve1", r3.SnapshotID, r3.NextCbt)))
	if r4.Cbt != "full" || r4.NextCbt != nil || r4.Consistency != "offline" {
		t.Fatalf("stopped VM: %+v", r4)
	}
}

func TestProxmoxE2EContainerFiles(t *testing.T) {
	mock, _, run := pveHarness(t)

	r := guestOK(t, run(backupTask("eeeeeeee-0000-0000-0000-000000000001", 101, pveTypeLXC, "pve1", "", nil)))
	if r.Method != pveMethodFiles || r.Consistency != "crash" {
		t.Fatalf("CT backup %+v", r)
	}
	st, _ := mock.read()
	g, _ := mock.guest(st, 101)
	if len(g.Snapshots) != 0 || g.Lock != "" {
		t.Fatalf("snapshot/lock left behind: %v %q", g.Snapshots, g.Lock)
	}

	// A file restore puts one file back into the container.
	conf := filepath.Join(mock.volDir(101, "rootfs"), "etc", "app.conf")
	os.WriteFile(conf, []byte("broken\n"), 0o640)
	rs := run(&Task{Type: "proxmox-restore", TaskID: "ffffffff-0000-0000-0000-000000000001", SnapshotID: r.SnapshotID,
		TargetPath: "/", IncludedPaths: []string{"/etc/app.conf"},
		Proxmox: &ProxmoxTask{ClusterSlug: "lab", Restore: &ProxmoxRestoreSpec{VMID: 101, GuestType: pveTypeLXC, Action: "files", TargetNode: "pve1"}}})
	if rs.Status != "success" {
		t.Fatalf("file restore: %+v\n%s", rs, rs.Log)
	}
	if data, _ := os.ReadFile(conf); string(data) != "setting=1\n" {
		t.Fatalf("file not restored: %q", data)
	}

	// The whole container as a new one: pct restore receives a vzdump-style tar.
	rs = run(restoreTask("ffffffff-0000-0000-0000-000000000002", r.SnapshotID,
		ProxmoxRestoreSpec{VMID: 101, GuestType: pveTypeLXC, Action: "guest", TargetNode: "pve1", NewVMID: 160}))
	if rs.Status != "success" {
		t.Fatalf("CT restore: %+v\n%s", rs, rs.Log)
	}
	root := filepath.Join(mock.dir, "disks", "160", "rootfs")
	if data, _ := os.ReadFile(filepath.Join(root, "etc", "hostname")); string(data) != "db\n" {
		t.Fatalf("rootfs file missing: %q", data)
	}
	if _, err := os.Stat(filepath.Join(root, "data", "table.db")); err != nil {
		t.Fatalf("mount point data missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "tmp", "scratch")); err == nil {
		t.Fatal("vzdump's default excludes (/tmp/?*) were backed up")
	}
	cfg, _ := mock.GuestConfig(nil, pveTypeLXC, 160)
	if cfg.Keys["hostname"] != "db" || cfg.Keys["unprivileged"] != "1" {
		t.Fatalf("restored CT config %v", cfg.Keys)
	}

	// A file restore from a non-files snapshot is refused.
	vz := guestOK(t, run(&Task{Type: "proxmox-backup", TaskID: "eeeeeeee-0000-0000-0000-000000000002",
		Proxmox: &ProxmoxTask{ClusterSlug: "lab", CTMethod: "vzdump", Guest: &ProxmoxGuestRef{VMID: 101, Type: pveTypeLXC, Node: "pve1"}}}))
	if vz.Method != pveMethodVzdump {
		t.Fatalf("forced vzdump: %+v", vz)
	}
	rs = run(&Task{Type: "proxmox-restore", TaskID: "ffffffff-0000-0000-0000-000000000003", SnapshotID: vz.SnapshotID,
		Proxmox: &ProxmoxTask{ClusterSlug: "lab", Restore: &ProxmoxRestoreSpec{VMID: 101, GuestType: pveTypeLXC, Action: "files", TargetNode: "pve1"}}})
	if rs.Status != "failed" || !strings.Contains(rs.Error, "file-level") {
		t.Fatalf("file restore from vzdump: %+v", rs)
	}
	// …while the vzdump tar restores as a whole container.
	rs = run(restoreTask("ffffffff-0000-0000-0000-000000000004", vz.SnapshotID,
		ProxmoxRestoreSpec{VMID: 101, GuestType: pveTypeLXC, Action: "guest", TargetNode: "pve1", NewVMID: 161}))
	if rs.Status != "success" {
		t.Fatalf("CT vzdump restore: %+v\n%s", rs, rs.Log)
	}
}

func TestProxmoxE2ELockedAndStale(t *testing.T) {
	mock, _, run := pveHarness(t)
	// A crashed run left a snapshot and its lock (with Amber's marker).
	if err := mock.Snapshot(nil, pveTypeLXC, 101, "amber-deadbeef0000"); err != nil {
		t.Fatal(err)
	}
	mock.SetLock(nil, pveTypeLXC, 101, "backup")
	os.MkdirAll(filepath.Dir(lockMarker(101)), 0o700)
	os.WriteFile(lockMarker(101), []byte("old"), 0o600)
	r := guestOK(t, run(backupTask("abababab-0000-0000-0000-000000000001", 101, pveTypeLXC, "pve1", "", nil)))
	if r.SnapshotID == "" {
		t.Fatal("no snapshot")
	}
	st, _ := mock.read()
	g, _ := mock.guest(st, 101)
	if len(g.Snapshots) != 0 || g.Lock != "" {
		t.Fatalf("stale state not cleaned: %v %q", g.Snapshots, g.Lock)
	}
	// A lock Amber did not set (e.g. PVE's own vzdump) is left alone.
	mock.SetLock(nil, pveTypeLXC, 101, "backup")
	res := run(backupTask("abababab-0000-0000-0000-000000000002", 101, pveTypeLXC, "pve1", "", nil))
	if res.ProxmoxGuest == nil || res.ProxmoxGuest.Status != "failed" || !strings.Contains(res.ProxmoxGuest.Error, "locked") {
		t.Fatalf("foreign lock: %+v", res.ProxmoxGuest)
	}
}
