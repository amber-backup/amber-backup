package main

// A simulated Hyper-V host for development and tests, enabled with
// AMBER_HYPERV_MOCK=<dir>. It keeps its VMs in <dir>/state.json and their
// "disks" and configuration files as real files under <dir>/vms, so backups
// and restores run through real restic. On first use it seeds three VMs.
//
// Behaviour knobs per VM in state.json:
//   backupIntegration=false  → no production checkpoint (crash-consistent fallback,
//                              or a failure with ProductionOnly)
//   failCheckpoint=true      → Checkpoint-VM fails
// A remote connection works like a local one (paths are local files), but
// needs an address and credentials, as the real thing does. As a cluster the
// host has two nodes, NODE1 and NODE2, that own the VMs (field "node"); a
// connection addressed at a node sees only that node's VMs.

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type mockVM struct {
	HypervVM
	Checkpoints    []string `json:"checkpoints"`
	FailCheckpoint bool     `json:"failCheckpoint,omitempty"`
	NICs           []vmNIC  `json:"nics,omitempty"`
}

type mockState struct {
	ComputerName string    `json:"computerName"`
	VMs          []*mockVM `json:"vms"`
}

type mockHyperv struct {
	dir string
	mu  sync.Mutex
}

func (m *mockHyperv) Name() string { return "mock" }

func (m *mockHyperv) statePath() string { return filepath.Join(m.dir, "state.json") }

func (m *mockHyperv) load() (*mockState, error) {
	data, err := os.ReadFile(m.statePath())
	if os.IsNotExist(err) {
		return m.seed()
	}
	if err != nil {
		return nil, err
	}
	var s mockState
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("mock state: %w", err)
	}
	return &s, nil
}

func (m *mockHyperv) save(s *mockState) error {
	data, _ := json.MarshalIndent(s, "", "  ")
	return os.WriteFile(m.statePath(), data, 0o600)
}

// seed creates three VMs: a running one with VSS, a running Linux one without
// backup integration, and a powered-off Gen1 VM with two disks.
func (m *mockHyperv) seed() (*mockState, error) {
	s := &mockState{ComputerName: "HV-MOCK-01"}
	specs := []struct {
		name, state     string
		gen             int
		vss             bool
		disks           int
		nicSwitch, vlan string
	}{
		{"dc01", "Running", 2, true, 1, "LAN", ""},
		{"web01", "Running", 2, false, 1, "DMZ", "20"},
		{"legacy-app", "Off", 1, true, 2, "LAN", ""},
	}
	for i, sp := range specs {
		id := newGUID()
		vmDir := filepath.Join(m.dir, "vms", sp.name)
		vm := &mockVM{HypervVM: HypervVM{
			ID: id, Name: sp.name, State: sp.state, Generation: sp.gen, Version: "10.0",
			ProcessorCount: 2, MemoryStartupBytes: 2 << 30, CheckpointType: "Production",
			BackupIntegration: sp.vss, ConfigurationLocation: vmDir, StaleCheckpoints: []string{},
			Node: mockNodes[i%len(mockNodes)],
		}}
		for i := 0; i < sp.disks; i++ {
			p := filepath.Join(vmDir, "Virtual Hard Disks", fmt.Sprintf("%s-disk%d.vhdx", sp.name, i))
			if err := writeRandomFile(p, 2<<20); err != nil {
				return nil, err
			}
			ctype := "SCSI"
			if sp.gen == 1 {
				ctype = "IDE"
			}
			vm.Disks = append(vm.Disks, HypervDisk{Path: p, ControllerType: ctype, ControllerLocation: i, SizeBytes: 64 << 30})
		}
		cfg := filepath.Join(vmDir, "Virtual Machines", strings.ToUpper(id)+".vmcx")
		if err := writeRandomFile(cfg, 32<<10); err != nil {
			return nil, err
		}
		nic := vmNIC{Name: "Network Adapter", SwitchName: sp.nicSwitch}
		fmt.Sscanf(sp.vlan, "%d", &nic.VlanID)
		vm.NICs = []vmNIC{nic}
		s.VMs = append(s.VMs, vm)
	}
	if err := m.save(s); err != nil {
		return nil, err
	}
	return s, nil
}

func (m *mockHyperv) Connect(_ context.Context, conn HypervConnection) (func(), error) {
	if conn.Mode == "remote" && (conn.Address == "" || conn.Username == "" || conn.Password == "") {
		return nil, errors.New("remote host needs an address and credentials")
	}
	return func() {}, nil
}

var mockNodes = []string{"NODE1", "NODE2"}

func (m *mockHyperv) ClusterNodes(_ context.Context, conn HypervConnection) ([]string, error) {
	if conn.Mode != "cluster" || conn.Address == "" || conn.Username == "" || conn.Password == "" {
		return nil, errors.New("a cluster needs its name and credentials")
	}
	return append([]string(nil), mockNodes...), nil
}

func isMockNode(address string) bool {
	for _, n := range mockNodes {
		if strings.EqualFold(n, address) {
			return true
		}
	}
	return false
}

func (m *mockHyperv) Inventory(_ context.Context, conn HypervConnection) (*HypervInventory, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.load()
	if err != nil {
		return nil, err
	}
	inv := &HypervInventory{ComputerName: s.ComputerName, OS: "Windows Server 2022 Datacenter (simulated)", VMs: []HypervVM{}}
	if conn.Mode == "remote" {
		inv.ComputerName = strings.ToUpper(strings.SplitN(conn.Address, ".", 2)[0])
	}
	nodeOnly := conn.Mode == "remote" && isMockNode(conn.Address)
	for _, vm := range s.VMs {
		if nodeOnly && !strings.EqualFold(vm.Node, conn.Address) {
			continue
		}
		v := vm.HypervVM
		v.Node = ""
		v.StaleCheckpoints = []string{}
		for _, c := range vm.Checkpoints {
			if strings.HasPrefix(c, checkpointPrefix) {
				v.StaleCheckpoints = append(v.StaleCheckpoints, c)
			}
		}
		v.Disks = append([]HypervDisk(nil), vm.Disks...)
		for i := range v.Disks {
			if fi, err := os.Stat(v.Disks[i].Path); err == nil {
				v.Disks[i].FileSizeBytes = fi.Size()
			}
		}
		inv.VMs = append(inv.VMs, v)
	}
	return inv, nil
}

func (m *mockHyperv) find(s *mockState, id string) *mockVM {
	for _, vm := range s.VMs {
		if strings.EqualFold(vm.ID, id) {
			return vm
		}
	}
	return nil
}

func (m *mockHyperv) PrepareBackup(_ context.Context, _ HypervConnection, vmID, checkpoint, mode string) (*vmBackupSet, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.load()
	if err != nil {
		return nil, err
	}
	vm := m.find(s, vmID)
	if vm == nil {
		return nil, fmt.Errorf("VM %s not found", vmID)
	}
	if vm.FailCheckpoint {
		return nil, errors.New("Checkpoint-VM: the operation failed (simulated)")
	}
	consistency := consistencyApp
	if !vm.BackupIntegration && vm.State == "Running" {
		if mode == checkpointModeOnly {
			return nil, errors.New("production checkpoint failed: the guest's backup integration service is not available")
		}
		consistency = consistencyCrash
	}
	vm.Checkpoints = append(vm.Checkpoints, checkpoint)
	if err := m.save(s); err != nil {
		return nil, err
	}
	set := &vmBackupSet{Checkpoint: checkpoint, Consistency: consistency, NICs: vm.NICs, SecureBoot: vm.Generation == 2, SecureBootTemplate: "MicrosoftWindows"}
	for _, d := range vm.Disks {
		set.Disks = append(set.Disks, vmDiskChain{ControllerType: d.ControllerType, ControllerNumber: d.ControllerNumber, ControllerLocation: d.ControllerLocation, Chain: []string{d.Path}})
	}
	cfgs, _ := filepath.Glob(filepath.Join(vm.ConfigurationLocation, "Virtual Machines", "*"))
	set.ConfigFiles = cfgs
	return set, nil
}

func (m *mockHyperv) RemoveCheckpoints(_ context.Context, _ HypervConnection, vmID string, names []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.load()
	if err != nil {
		return err
	}
	vm := m.find(s, vmID)
	if vm == nil {
		return fmt.Errorf("VM %s not found", vmID)
	}
	drop := map[string]bool{}
	for _, n := range names {
		drop[n] = true
	}
	kept := []string{}
	for _, c := range vm.Checkpoints {
		if !drop[c] {
			kept = append(kept, c)
		}
	}
	vm.Checkpoints = kept
	return m.save(s)
}

func (m *mockHyperv) RegisterVM(_ context.Context, conn HypervConnection, req registerRequest) (*registeredVM, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.load()
	if err != nil {
		return nil, err
	}
	for _, vm := range s.VMs {
		if strings.EqualFold(vm.Name, req.Name) {
			return nil, fmt.Errorf("a VM named %q already exists", req.Name)
		}
	}
	src := req.Manifest.VM
	vm := &mockVM{HypervVM: HypervVM{
		ID: newGUID(), Name: req.Name, State: "Off", Generation: src.Generation, Version: src.Version,
		ProcessorCount: src.ProcessorCount, MemoryStartupBytes: src.MemoryStartupBytes,
		CheckpointType: src.CheckpointType, BackupIntegration: src.BackupIntegration,
		ConfigurationLocation: req.VMPath, StaleCheckpoints: []string{},
	}}
	if isMockNode(conn.Address) {
		vm.Node = strings.ToUpper(conn.Address)
	}
	for _, d := range req.Disks {
		if len(d.Chain) == 0 {
			return nil, errors.New("a disk without files")
		}
		for _, p := range d.Chain {
			if _, err := os.Stat(p); err != nil {
				return nil, fmt.Errorf("disk file missing: %w", err)
			}
		}
		// The real backend merges a chain into its base disk.
		vm.Disks = append(vm.Disks, HypervDisk{Path: d.Chain[0], ControllerType: d.ControllerType, ControllerNumber: d.ControllerNumber, ControllerLocation: d.ControllerLocation, SizeBytes: 64 << 30})
	}
	for _, n := range req.Manifest.Set.NICs {
		if !req.ConnectNetwork {
			n.SwitchName = ""
		}
		vm.NICs = append(vm.NICs, n)
	}
	if req.Start {
		vm.State = "Running"
	}
	s.VMs = append(s.VMs, vm)
	if err := m.save(s); err != nil {
		return nil, err
	}
	var warnings []string
	if req.Manifest.Set.TPM {
		warnings = append(warnings, "the VM had a virtual TPM; the restored one gets new TPM keys")
	}
	return &registeredVM{ID: vm.ID, Name: vm.Name, Warnings: warnings}, nil
}

func (m *mockHyperv) RemoveVM(_ context.Context, _ HypervConnection, vmID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.load()
	if err != nil {
		return err
	}
	kept := s.VMs[:0]
	found := false
	for _, vm := range s.VMs {
		if strings.EqualFold(vm.ID, vmID) {
			found = true
			continue
		}
		kept = append(kept, vm)
	}
	if !found {
		return fmt.Errorf("VM %s not found", vmID)
	}
	s.VMs = kept
	return m.save(s)
}

func (m *mockHyperv) AgentPath(_ HypervConnection, hostPath string) string { return hostPath }

func writeRandomFile(p string, size int) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	buf := make([]byte, size)
	rand.Read(buf)
	return os.WriteFile(p, buf, 0o644)
}

func newGUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
