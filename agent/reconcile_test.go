package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestRemoveStaleTemp(t *testing.T) {
	dir := t.TempDir()
	for _, d := range []string{"amber-restic-123456", "amber-nbd-42", "amber-restic-cache", "other-1"} {
		os.MkdirAll(filepath.Join(dir, d), 0o700)
	}
	os.WriteFile(filepath.Join(dir, "amber-restic-123456", "ssh-key"), []byte("secret"), 0o600)
	os.WriteFile(filepath.Join(dir, "amber-hv-99.ps1"), []byte("x"), 0o600)
	os.WriteFile(filepath.Join(dir, "amber-hv-notes.txt"), []byte("x"), 0o600)

	if n := removeStaleTemp(dir); n != 3 {
		t.Fatalf("removed %d items, want 3", n)
	}
	for _, gone := range []string{"amber-restic-123456", "amber-nbd-42", "amber-hv-99.ps1"} {
		if _, err := os.Stat(filepath.Join(dir, gone)); !os.IsNotExist(err) {
			t.Fatalf("%s survived", gone)
		}
	}
	for _, kept := range []string{"amber-restic-cache", "other-1", "amber-hv-notes.txt"} {
		if _, err := os.Stat(filepath.Join(dir, kept)); err != nil {
			t.Fatalf("%s was removed", kept)
		}
	}
}

func TestReleaseStaleLocksOnStart(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("INSTALL_DIR", filepath.Join(tmp, "install"))
	mock := newMockPve(filepath.Join(tmp, "cluster"))
	rt := &pveRuntime{backend: mock, busy: map[int]bool{}}
	ctx := context.Background()

	// A killed run left snapshot + lock on 101 (with Amber's marker); 102 has
	// a lock Amber did not set; 200 lives on another node; 999 is gone.
	if err := mock.Snapshot(ctx, pveTypeLXC, 101, "amber-deadbeef0000"); err != nil {
		t.Fatal(err)
	}
	mock.SetLock(ctx, pveTypeLXC, 101, "backup")
	mock.SetLock(ctx, pveTypeQemu, 102, "backup")
	mock.SetLock(ctx, pveTypeQemu, 200, "backup")
	os.MkdirAll(filepath.Dir(lockMarker(0)), 0o700)
	for _, id := range []int{101, 200, 999} {
		os.WriteFile(lockMarker(id), []byte("old-task"), 0o600)
	}

	if left := rt.releaseStaleLocks(ctx); left != 0 {
		t.Fatalf("%d markers left", left)
	}
	st, _ := mock.read()
	g, _ := mock.guest(st, 101)
	if g.Lock != "" || len(g.Snapshots) != 0 {
		t.Fatalf("guest 101 not cleaned: lock %q snapshots %v", g.Lock, g.Snapshots)
	}
	if g, _ := mock.guest(st, 102); g.Lock != "backup" {
		t.Fatal("a lock without Amber's marker was removed")
	}
	if g, _ := mock.guest(st, 200); g.Lock != "backup" {
		t.Fatal("a guest of another node was touched")
	}
	for _, id := range []int{101, 200, 999} {
		if _, err := os.Stat(lockMarker(id)); !os.IsNotExist(err) {
			t.Fatalf("marker of %d left", id)
		}
	}
}

func TestReleaseStaleLocksSkipsGuestInUse(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("INSTALL_DIR", filepath.Join(tmp, "install"))
	mock := newMockPve(filepath.Join(tmp, "cluster"))
	rt := &pveRuntime{backend: mock, busy: map[int]bool{101: true}}
	mock.SetLock(context.Background(), pveTypeLXC, 101, "backup")
	os.MkdirAll(filepath.Dir(lockMarker(0)), 0o700)
	os.WriteFile(lockMarker(101), []byte("running"), 0o600)

	rt.releaseStaleLocks(context.Background())
	st, _ := mock.read()
	if g, _ := mock.guest(st, 101); g.Lock != "backup" {
		t.Fatal("the lock of a guest being backed up was removed")
	}
	if _, err := os.Stat(lockMarker(101)); err != nil {
		t.Fatal("the marker of a guest being backed up was removed")
	}
}
