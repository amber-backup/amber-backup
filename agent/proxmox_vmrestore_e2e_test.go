package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// blockBackupForRestore backs up VM 100 with the block method (skips without FUSE).
func blockBackupForRestore(t *testing.T, run func(*Task) TaskResult) *ProxmoxGuestResult {
	t.Helper()
	res := run(backupTask("eeeeeeee-0000-0000-0000-000000000001", 100, pveTypeQemu, "pve1", "", nil))
	if res.ProxmoxGuest != nil && strings.Contains(res.ProxmoxGuest.Error, "mounting the segment view") {
		t.Skipf("FUSE not available: %s", res.ProxmoxGuest.Error)
	}
	r := guestOK(t, res)
	if r.Method != pveMethodBlock {
		t.Fatalf("method %s", r.Method)
	}
	return r
}

func TestProxmoxE2EVMFileRestore(t *testing.T) {
	mock, tmp, run := pveHarness(t)
	r := blockBackupForRestore(t, run)

	// The guest's filesystems on scsi0: p1 with /etc/nginx, p2 with /data.
	mock.SetGuestFile(100, "scsi0", 1, "etc/nginx/nginx.conf", []byte("worker_processes 2;\n"), 0o640)
	mock.SetGuestFile(100, "scsi0", 1, "etc/hostname", []byte("web\n"), 0o644)
	mock.SetGuestFile(100, "scsi0", 2, "data/report.csv", []byte("a,b\n1,2\n"), 0o600)

	target := filepath.Join(tmp, "out")
	task := restoreTask("ffffffff-0000-0000-0000-000000000001", r.SnapshotID,
		ProxmoxRestoreSpec{VMID: 100, GuestType: pveTypeQemu, Action: "vm-files", TargetNode: "pve1", TargetPath: target})
	task.IncludedPaths = []string{"/etc/nginx", "p2:/data/report.csv"}
	rs := run(task)
	if rs.Status != "success" {
		t.Fatalf("vm-files restore: %+v\n%s", rs, rs.Log)
	}
	if b, _ := os.ReadFile(filepath.Join(target, "scsi0-p1", "etc", "nginx", "nginx.conf")); string(b) != "worker_processes 2;\n" {
		t.Fatalf("nginx.conf: %q", b)
	}
	if _, err := os.Stat(filepath.Join(target, "scsi0-p1", "etc", "hostname")); err == nil {
		t.Fatal("unselected file restored")
	}
	if b, _ := os.ReadFile(filepath.Join(target, "scsi0-p2", "data", "report.csv")); string(b) != "a,b\n1,2\n" {
		t.Fatalf("report.csv: %q", b)
	}
	if mock.Attached() != 0 {
		t.Fatalf("%d images still attached", mock.Attached())
	}
	if m := mountsBelowOrNone(filepath.Join(tmp, "mnt")); len(m) != 0 {
		t.Fatalf("still mounted: %v", m)
	}

	// Only block backups of VMs, and a sane target.
	bad := restoreTask("ffffffff-0000-0000-0000-000000000002", r.SnapshotID,
		ProxmoxRestoreSpec{VMID: 100, GuestType: pveTypeQemu, Action: "vm-files", TargetNode: "pve1", TargetPath: "/"})
	if rs := run(bad); rs.Status != "failed" || !strings.Contains(rs.Error, "absolute path other than /") {
		t.Fatalf("target / accepted: %+v", rs)
	}
	none := restoreTask("ffffffff-0000-0000-0000-000000000003", r.SnapshotID,
		ProxmoxRestoreSpec{VMID: 100, GuestType: pveTypeQemu, Action: "vm-files", TargetNode: "pve1", TargetPath: target})
	none.IncludedPaths = []string{"/does/not/exist"}
	if rs := run(none); rs.Status != "failed" || !strings.Contains(rs.Error, "none of the paths") {
		t.Fatalf("missing path: %+v", rs)
	}
	if mock.Attached() != 0 {
		t.Fatalf("%d images still attached after a failure", mock.Attached())
	}
}

func TestProxmoxE2ELiveRestore(t *testing.T) {
	mock, tmp, run := pveHarness(t)
	r := blockBackupForRestore(t, run)

	// The overlay storage must take qcow2.
	bad := run(restoreTask("abababab-0000-0000-0000-000000000001", r.SnapshotID,
		ProxmoxRestoreSpec{VMID: 100, GuestType: pveTypeQemu, Action: "guest", TargetNode: "pve1", NewVMID: 161,
			LiveRestore: true, OverlayStorage: "local-zfs"}))
	if bad.Status != "failed" || !strings.Contains(bad.Error, "cannot hold qcow2") {
		t.Fatalf("zfs overlay accepted: %+v", bad)
	}
	if _, _, err := mock.LocateGuest(nil, 161); err == nil {
		t.Fatal("VM 161 created by a failed live restore")
	}

	rs := run(restoreTask("abababab-0000-0000-0000-000000000002", r.SnapshotID,
		ProxmoxRestoreSpec{VMID: 100, GuestType: pveTypeQemu, Action: "guest", TargetNode: "pve1", NewVMID: 160,
			LiveRestore: true, OverlayStorage: "local", Storage: "local-zfs", Unique: true, Name: "web-live"}))
	if rs.Status != "success" {
		t.Fatalf("live restore: %+v\n%s", rs, rs.Log)
	}
	if s, _ := mock.GuestStatus(nil, pveTypeQemu, 160); s != "running" {
		t.Fatalf("VM 160 is %s", s)
	}
	for _, key := range []string{"scsi0", "efidisk0"} {
		want, _ := os.ReadFile(mock.diskPath(100, key))
		got, err := os.ReadFile(mock.diskPath(160, key))
		if err != nil || !bytes.Equal(want, got) {
			t.Fatalf("live-restored %s differs (%v)", key, err)
		}
	}
	cfg, _ := mock.GuestConfig(nil, pveTypeQemu, 160)
	if !strings.HasPrefix(cfg.Keys["scsi0"], "local-zfs:vm-160-disk-scsi0,") || !strings.HasPrefix(cfg.Keys["efidisk0"], "local-zfs:") {
		t.Fatalf("disks not moved: %v", cfg.Keys)
	}
	if cfg.Keys["name"] != "web-live" || strings.Contains(cfg.Keys["net0"], "00:00:01") {
		t.Fatalf("config %v", cfg.Keys)
	}
	if ov, _ := os.ReadDir(filepath.Join(mock.dir, "overlays")); len(ov) != 0 {
		t.Fatalf("overlays left: %v", ov)
	}
	if m := mountsBelowOrNone(filepath.Join(tmp, "mnt")); len(m) != 0 {
		t.Fatalf("still mounted: %v", m)
	}
}
