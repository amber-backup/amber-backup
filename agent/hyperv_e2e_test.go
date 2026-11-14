package main

import (
	"bytes"
	"crypto/sha256"
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

// End to end against the simulated Hyper-V host and a real restic, which
// AMBER_TEST_RESTIC must name (skipped otherwise):
//
//	AMBER_TEST_RESTIC=$(command -v restic) go test -run HypervE2E ./...
//
// e2eHarness wires an agent with the simulated host, a real restic and a fake
// server that records the task results; run executes a task and returns its result.
func e2eHarness(t *testing.T) (mock *mockHyperv, tmp string, run func(*Task) TaskResult) {
	t.Helper()
	restic := os.Getenv("AMBER_TEST_RESTIC")
	if restic == "" {
		t.Skip("AMBER_TEST_RESTIC not set")
	}
	tmp = t.TempDir()
	t.Setenv("INSTALL_DIR", filepath.Join(tmp, "install"))
	mock = &mockHyperv{dir: filepath.Join(tmp, "host")}

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
		baseURL: srv.URL, http: srv.Client(), hyperv: mock,
		runner: &resticRunner{binary: restic, cacheDir: filepath.Join(tmp, "cache"), stopGrace: defaultStopGrace},
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

func TestHypervE2E(t *testing.T) {
	mock, tmp, run := e2eHarness(t)
	local := HypervConnection{Mode: "local"}

	// Inventory: the three seeded VMs.
	inv := run(&Task{Type: "hyperv-inventory", TaskID: "hvinv-host", Hyperv: &HypervTask{Connection: local}})
	if inv.Status != "success" || inv.HypervInventory == nil || len(inv.HypervInventory.VMs) != 3 {
		t.Fatalf("inventory = %+v", inv)
	}
	vmByName := map[string]HypervVM{}
	for _, vm := range inv.HypervInventory.VMs {
		vmByName[vm.Name] = vm
	}
	dc := vmByName["dc01"]

	// Backup of all VMs: web01 has no guest VSS, so it falls back to crash-consistent.
	keep := 3
	res := run(&Task{Type: "hyperv-backup", TaskID: "11111111-0000-0000-0000-000000000001",
		Options: &ResticOptions{Retention: &Retention{KeepLast: &keep}},
		Hyperv:  &HypervTask{Connection: local, AllVMs: true, CheckpointMode: "Production"}})
	if res.Status != "success" {
		t.Fatalf("backup failed: %s\n%s", res.Error, res.Log)
	}
	vmResults := decodeVMResults(t, res.Stats)
	if len(vmResults) != 3 {
		t.Fatalf("vm results = %+v", vmResults)
	}
	consistency := map[string]string{}
	for _, r := range vmResults {
		if r.Status != "success" || r.SnapshotID == "" {
			t.Fatalf("VM %s: %+v", r.Name, r)
		}
		consistency[r.Name] = r.Consistency
	}
	if consistency["web01"] != consistencyCrash || consistency["dc01"] != consistencyApp {
		t.Fatalf("consistency = %v", consistency)
	}
	assertNoCheckpoints(t, mock)

	// ProductionOnly: web01 fails, the others still get their snapshot.
	res = run(&Task{Type: "hyperv-backup", TaskID: "11111111-0000-0000-0000-000000000002",
		Hyperv: &HypervTask{Connection: local, AllVMs: true, CheckpointMode: "ProductionOnly"}})
	if res.Status != "failed" || !strings.Contains(res.Error, "1 of 3 VMs failed") {
		t.Fatalf("ProductionOnly run = %s: %s", res.Status, res.Error)
	}
	if n := countSuccess(decodeVMResults(t, res.Stats)); n != 2 {
		t.Fatalf("%d VMs succeeded, want 2", n)
	}
	assertNoCheckpoints(t, mock)

	// Restore dc01 as a new VM; its disk must come back bit for bit.
	var dcSnapshot string
	for _, r := range vmResults {
		if r.Name == "dc01" {
			dcSnapshot = r.SnapshotID
		}
	}
	target := filepath.Join(tmp, "restore")
	os.MkdirAll(target, 0o755)
	res = run(&Task{Type: "hyperv-restore", TaskID: "22222222-0000-0000-0000-000000000001", SnapshotID: dcSnapshot,
		Hyperv: &HypervTask{Connection: local, Restore: &HypervRestoreSpec{VMID: dc.ID, Action: "vm", TargetPath: target}}})
	if res.Status != "success" {
		t.Fatalf("restore failed: %s\n%s", res.Error, res.Log)
	}
	restored := findMockVM(t, mock, "dc01 (restored)")
	if restored.ID == dc.ID || len(restored.Disks) != 1 {
		t.Fatalf("restored VM = %+v", restored)
	}
	if fileHash(t, restored.Disks[0].Path) != fileHash(t, dc.Disks[0].Path) {
		t.Fatal("restored disk differs from the original")
	}
	if len(restored.NICs) != 1 || restored.NICs[0].SwitchName != "" {
		t.Fatalf("restored NICs should be disconnected: %+v", restored.NICs)
	}

	// The wrong VM id is refused.
	res = run(&Task{Type: "hyperv-restore", TaskID: "22222222-0000-0000-0000-000000000002", SnapshotID: dcSnapshot,
		Hyperv: &HypervTask{Connection: local, Restore: &HypervRestoreSpec{VMID: vmByName["web01"].ID, Action: "vm", TargetPath: target}}})
	if res.Status != "failed" || !strings.Contains(res.Error, "holds VM") {
		t.Fatalf("restore of the wrong VM = %s: %s", res.Status, res.Error)
	}

	// Replacing the original keeps the name, drops the old registration.
	res = run(&Task{Type: "hyperv-restore", TaskID: "22222222-0000-0000-0000-000000000003", SnapshotID: dcSnapshot,
		Hyperv: &HypervTask{Connection: local, Restore: &HypervRestoreSpec{VMID: dc.ID, Action: "vm", ReplaceOriginal: true, Start: true, TargetPath: filepath.Join(tmp, "replace")}}})
	if res.Status != "success" {
		t.Fatalf("replace failed: %s\n%s", res.Error, res.Log)
	}
	replaced := findMockVM(t, mock, "dc01")
	if replaced.ID == dc.ID || replaced.State != "Running" {
		t.Fatalf("replaced VM = %+v", replaced)
	}
	info, _ := res.Stats["hypervRestore"].(map[string]any)
	if info["vmId"] != replaced.ID || info["replacedOriginal"] != true {
		t.Fatalf("restore info = %v", info)
	}

	// Disks only.
	res = run(&Task{Type: "hyperv-restore", TaskID: "22222222-0000-0000-0000-000000000004", SnapshotID: dcSnapshot,
		Hyperv: &HypervTask{Connection: local, Restore: &HypervRestoreSpec{VMID: dc.ID, Action: "disks", NewName: "dc01-disks", TargetPath: target}}})
	if res.Status != "success" {
		t.Fatalf("disk restore failed: %s", res.Error)
	}
	if _, err := os.Stat(filepath.Join(target, "dc01-disks", "Virtual Hard Disks", "dc01-disk0.vhdx")); err != nil {
		t.Fatalf("restored disk missing: %v", err)
	}
	if entries, _ := os.ReadDir(target); hasStaging(entries) {
		t.Fatal("staging folder left behind")
	}
}

func decodeVMResults(t *testing.T, stats map[string]any) []HypervVMResult {
	t.Helper()
	raw, _ := json.Marshal(stats["hypervVms"])
	var out []HypervVMResult
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("hypervVms: %v", err)
	}
	return out
}

func countSuccess(rs []HypervVMResult) int {
	n := 0
	for _, r := range rs {
		if r.Status == "success" {
			n++
		}
	}
	return n
}

func assertNoCheckpoints(t *testing.T, m *mockHyperv) {
	t.Helper()
	s, err := m.load()
	if err != nil {
		t.Fatal(err)
	}
	for _, vm := range s.VMs {
		if len(vm.Checkpoints) > 0 {
			t.Fatalf("VM %s kept checkpoints %v", vm.Name, vm.Checkpoints)
		}
	}
}

func findMockVM(t *testing.T, m *mockHyperv, name string) *mockVM {
	t.Helper()
	s, err := m.load()
	if err != nil {
		t.Fatal(err)
	}
	for _, vm := range s.VMs {
		if vm.Name == name {
			return vm
		}
	}
	t.Fatalf("no VM %q in %+v", name, s.VMs)
	return nil
}

func fileHash(t *testing.T, p string) [32]byte {
	t.Helper()
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(data)
}

func hasStaging(entries []os.DirEntry) bool {
	for _, e := range entries {
		if bytes.HasPrefix([]byte(e.Name()), []byte(".amber-restore-")) {
			return true
		}
	}
	return false
}

// A failover cluster: VMs spread over two nodes, backed up in parallel through
// their owner nodes under the cluster's name, and restored onto a chosen node.
func TestHypervClusterE2E(t *testing.T) {
	mock, tmp, run := e2eHarness(t)
	cluster := HypervConnection{Mode: "cluster", Address: "hvclu.corp.local", Username: `CORP\backup`, Password: "pw"}

	inv := run(&Task{Type: "hyperv-inventory", TaskID: "hvinv-cluster", Hyperv: &HypervTask{Connection: cluster}})
	if inv.Status != "success" || inv.HypervInventory.ComputerName != "HVCLU" || len(inv.HypervInventory.VMs) != 3 {
		t.Fatalf("cluster inventory = %+v (%s)", inv.HypervInventory, inv.Error)
	}
	nodes := map[string]string{}
	for _, vm := range inv.HypervInventory.VMs {
		nodes[vm.Name] = vm.Node
	}
	if nodes["dc01"] != "NODE1" || nodes["web01"] != "NODE2" {
		t.Fatalf("owner nodes = %v", nodes)
	}

	res := run(&Task{Type: "hyperv-backup", TaskID: "33333333-0000-0000-0000-000000000001",
		Hyperv: &HypervTask{Connection: cluster, AllVMs: true, ParallelVMs: 3}})
	if res.Status != "success" {
		t.Fatalf("cluster backup failed: %s\n%s", res.Error, res.Log)
	}
	vmResults := decodeVMResults(t, res.Stats)
	if countSuccess(vmResults) != 3 {
		t.Fatalf("vm results = %+v", vmResults)
	}
	assertNoCheckpoints(t, mock)
	if !strings.Contains(res.Log, "on node NODE2") {
		t.Fatalf("VMs not reached through their nodes:\n%s", res.Log)
	}

	var dc HypervVM
	for _, vm := range inv.HypervInventory.VMs {
		if vm.Name == "dc01" {
			dc = vm
		}
	}
	var snap string
	for _, r := range vmResults {
		if r.Name == "dc01" {
			snap = r.SnapshotID
		}
	}
	target := filepath.Join(tmp, "csv")
	os.MkdirAll(target, 0o755)
	res = run(&Task{Type: "hyperv-restore", TaskID: "44444444-0000-0000-0000-000000000001", SnapshotID: snap,
		Hyperv: &HypervTask{Connection: cluster, Restore: &HypervRestoreSpec{VMID: dc.ID, Action: "vm", Node: "NODE2", NewName: "dc01-copy", TargetPath: target}}})
	if res.Status != "success" {
		t.Fatalf("cluster restore failed: %s\n%s", res.Error, res.Log)
	}
	if vm := findMockVM(t, mock, "dc01-copy"); vm.Node != "NODE2" {
		t.Fatalf("restored onto %q, want NODE2", vm.Node)
	}
}
