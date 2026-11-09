package main

// Hyper-V: inventory, backup and restore of virtual machines.
//
// The agent drives Hyper-V through a hypervBackend: PowerShell on a Windows
// host (hyperv_powershell.go; the host itself, or a remote host over
// PowerShell remoting), or a simulated host for development and tests
// (hyperv_mock.go, AMBER_HYPERV_MOCK).
//
// A VM backup takes a checkpoint (production = application-consistent through
// the guest's VSS, or crash-consistent as a fallback), after which the VM writes
// into a new differencing disk and the disks in front of it are read-only.
// Those disks, the VM's configuration files (local hosts only) and a manifest
// describing the VM go into one restic snapshot per VM, tagged amber-hyperv and
// vm:<id>. The checkpoint is then removed, which merges it back.
//
// A restore puts the snapshot's files into a staging folder on the host, merges
// each disk chain into one disk and builds a new VM from the manifest (or only
// restores the disks).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// --- Wire types (mirror server/src/hyperv/hyperv.contract.ts) ---------------

type HypervConnection struct {
	Mode     string `json:"mode"` // local | remote
	Address  string `json:"address,omitempty"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

type HypervRestoreSpec struct {
	HostID          string `json:"hostId"`
	VMID            string `json:"vmId"`
	Action          string `json:"action"` // vm | disks
	NewName         string `json:"newName,omitempty"`
	ReplaceOriginal bool   `json:"replaceOriginal,omitempty"`
	Start           bool   `json:"start,omitempty"`
	ConnectNetwork  bool   `json:"connectNetwork,omitempty"`
	// Cluster hosts: the node to register the VM on (default: the first node).
	Node       string `json:"node,omitempty"`
	TargetPath string `json:"targetPath"`
}

type HypervTask struct {
	Connection     HypervConnection   `json:"connection"`
	AllVMs         bool               `json:"allVms,omitempty"`
	VMIDs          []string           `json:"vmIds,omitempty"`
	ExcludeVMIDs   []string           `json:"excludeVmIds,omitempty"`
	CheckpointMode string             `json:"checkpointMode,omitempty"` // Production | ProductionOnly
	ParallelVMs    int                `json:"parallelVms,omitempty"`
	Restore        *HypervRestoreSpec `json:"restore,omitempty"`
}

type HypervDisk struct {
	Path               string `json:"path"`
	ControllerType     string `json:"controllerType"`
	ControllerNumber   int    `json:"controllerNumber"`
	ControllerLocation int    `json:"controllerLocation"`
	FileSizeBytes      int64  `json:"fileSizeBytes"`
	SizeBytes          int64  `json:"sizeBytes"`
}

type HypervVM struct {
	ID                    string       `json:"id"`
	Name                  string       `json:"name"`
	State                 string       `json:"state"`
	Generation            int          `json:"generation"`
	Version               string       `json:"version"`
	ProcessorCount        int          `json:"processorCount"`
	MemoryStartupBytes    int64        `json:"memoryStartupBytes"`
	CheckpointType        string       `json:"checkpointType"`
	BackupIntegration     bool         `json:"backupIntegration"`
	ConfigurationLocation string       `json:"configurationLocation"`
	Disks                 []HypervDisk `json:"disks"`
	StaleCheckpoints      []string     `json:"staleCheckpoints"`
	Notes                 string       `json:"notes,omitempty"`
	// Cluster hosts: the node that currently owns the VM.
	Node string `json:"node,omitempty"`
}

type HypervInventory struct {
	ComputerName string     `json:"computerName"`
	OS           string     `json:"os"`
	VMs          []HypervVM `json:"vms"`
}

// HypervVMResult is one VM's outcome in a backup run (server: HypervVmRunResult).
type HypervVMResult struct {
	VMID            string  `json:"vmId"`
	Name            string  `json:"name"`
	Status          string  `json:"status"` // success | failed
	SnapshotID      string  `json:"snapshotId,omitempty"`
	Consistency     string  `json:"consistency,omitempty"`
	Error           string  `json:"error,omitempty"`
	DataAdded       float64 `json:"dataAdded,omitempty"`
	TotalBytes      float64 `json:"totalBytes,omitempty"`
	DurationSeconds float64 `json:"durationSeconds,omitempty"`
}

const (
	hypervSnapshotTag  = "amber-hyperv"
	manifestFileName   = "amber-vm.json"
	checkpointPrefix   = "amber-"
	manifestFormat     = 1
	consistencyApp     = "application"
	consistencyCrash   = "crash"
	checkpointModeOnly = "ProductionOnly"
)

func vmTag(id string) string { return "vm:" + strings.ToLower(id) }

// --- Backend ----------------------------------------------------------------

// vmNIC is a network adapter as the manifest records it.
type vmNIC struct {
	Name       string `json:"name"`
	SwitchName string `json:"switchName,omitempty"`
	MacAddress string `json:"macAddress,omitempty"`
	StaticMac  bool   `json:"staticMac,omitempty"`
	VlanID     int    `json:"vlanId,omitempty"`
}

// vmDiskChain is one attached disk: the read-only files to back up, oldest
// (the base disk) first. The checkpoint's new differencing disk is not part of it.
type vmDiskChain struct {
	ControllerType     string   `json:"controllerType"`
	ControllerNumber   int      `json:"controllerNumber"`
	ControllerLocation int      `json:"controllerLocation"`
	Chain              []string `json:"chain"`
}

// vmBackupSet is what PrepareBackup hands back once the checkpoint exists.
type vmBackupSet struct {
	Checkpoint  string        `json:"checkpoint"`
	Consistency string        `json:"consistency"`
	Disks       []vmDiskChain `json:"disks"`
	// Configuration files (.vmcx, .vmgs, .vmrs); local hosts only.
	ConfigFiles []string `json:"configFiles,omitempty"`
	NICs        []vmNIC  `json:"nics,omitempty"`
	// Settings New-VM needs to rebuild the VM.
	DynamicMemory      bool   `json:"dynamicMemory,omitempty"`
	MemoryMinimumBytes int64  `json:"memoryMinimumBytes,omitempty"`
	MemoryMaximumBytes int64  `json:"memoryMaximumBytes,omitempty"`
	SecureBoot         bool   `json:"secureBoot,omitempty"`
	SecureBootTemplate string `json:"secureBootTemplate,omitempty"`
	TPM                bool   `json:"tpm,omitempty"`
}

// vmManifest is stored with every VM snapshot (amber-vm.json).
type vmManifest struct {
	Format       int         `json:"format"`
	ComputerName string      `json:"computerName"`
	BackedUpAt   string      `json:"backedUpAt"`
	VM           HypervVM    `json:"vm"`
	Set          vmBackupSet `json:"set"`
}

// registerRequest asks the backend to build a VM from restored files.
type registerRequest struct {
	Manifest vmManifest `json:"manifest"`
	Name     string     `json:"name"`
	VMPath   string     `json:"vmPath"`
	// Disks in manifest order, each chain with its restored host paths (base first).
	Disks          []vmDiskChain `json:"disks"`
	Start          bool          `json:"start"`
	ConnectNetwork bool          `json:"connectNetwork"`
	// Keep static MAC addresses: only when the VM replaces the original.
	KeepMac bool `json:"keepMac"`
	// Make the VM highly available (Add-ClusterVirtualMachineRole).
	ClusterRole bool `json:"clusterRole"`
}

type registeredVM struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Warnings []string `json:"warnings,omitempty"`
}

type hypervBackend interface {
	Name() string
	// Connect prepares access to a remote host (SMB session for the disks);
	// the returned func ends it. Local hosts need nothing.
	Connect(ctx context.Context, conn HypervConnection) (func(), error)
	// ClusterNodes lists the nodes of a failover cluster (conn.Mode "cluster").
	ClusterNodes(ctx context.Context, conn HypervConnection) ([]string, error)
	Inventory(ctx context.Context, conn HypervConnection) (*HypervInventory, error)
	PrepareBackup(ctx context.Context, conn HypervConnection, vmID, checkpoint, mode string) (*vmBackupSet, error)
	RemoveCheckpoints(ctx context.Context, conn HypervConnection, vmID string, names []string) error
	RegisterVM(ctx context.Context, conn HypervConnection, req registerRequest) (*registeredVM, error)
	RemoveVM(ctx context.Context, conn HypervConnection, vmID string) error
	// AgentPath maps a path on the Hyper-V host to one the agent can open
	// (identity locally, \\host\D$\… for a remote host).
	AgentPath(conn HypervConnection, hostPath string) string
}

// newHypervBackend picks the backend: the mock when AMBER_HYPERV_MOCK names a
// directory, PowerShell on Windows hosts with the Hyper-V module, else none.
func newHypervBackend() hypervBackend {
	if dir := os.Getenv("AMBER_HYPERV_MOCK"); dir != "" {
		log.Printf("Hyper-V: using the simulated host in %s (AMBER_HYPERV_MOCK)", dir)
		return &mockHyperv{dir: dir}
	}
	if b := newPowershellHyperv(); b != nil {
		return b
	}
	return nil
}

// --- Selection ----------------------------------------------------------------

// selectVMs resolves a job's selection against the inventory. Selected VMs
// that no longer exist are reported, not silently dropped.
func selectVMs(inv *HypervInventory, h *HypervTask) (vms []HypervVM, missing []string) {
	byID := map[string]HypervVM{}
	for _, vm := range inv.VMs {
		byID[strings.ToLower(vm.ID)] = vm
	}
	if h.AllVMs {
		skip := map[string]bool{}
		for _, id := range h.ExcludeVMIDs {
			skip[strings.ToLower(id)] = true
		}
		for _, vm := range inv.VMs {
			if !skip[strings.ToLower(vm.ID)] {
				vms = append(vms, vm)
			}
		}
	} else {
		for _, id := range h.VMIDs {
			if vm, ok := byID[strings.ToLower(id)]; ok {
				vms = append(vms, vm)
			} else {
				missing = append(missing, id)
			}
		}
	}
	sort.SliceStable(vms, func(i, j int) bool { return strings.ToLower(vms[i].Name) < strings.ToLower(vms[j].Name) })
	return vms, missing
}

// --- Sessions -----------------------------------------------------------------

// hvSession hands out connections for one task. A local or remote host has one;
// a cluster has one per node — each VM is reached through the node that owns
// it, like a remote host — opened on first use and all closed at the end.
type hvSession struct {
	backend hypervBackend
	base    HypervConnection
	mu      sync.Mutex
	open    map[string]HypervConnection
	closers []func()
}

func (a *agent) newSession(ctx context.Context, conn HypervConnection) (*hvSession, error) {
	s := &hvSession{backend: a.hyperv, base: conn, open: map[string]HypervConnection{}}
	if conn.Mode != "cluster" {
		if _, err := s.conn(ctx, ""); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// conn returns the connection for a VM's node ("" for a plain host).
func (s *hvSession) conn(ctx context.Context, node string) (HypervConnection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := strings.ToLower(node)
	if c, ok := s.open[key]; ok {
		return c, nil
	}
	c := s.base
	if s.base.Mode == "cluster" {
		if node == "" {
			return c, errors.New("no cluster node given")
		}
		c.Mode, c.Address = "remote", node
	}
	done, err := s.backend.Connect(ctx, c)
	if err != nil {
		return c, err
	}
	s.open[key] = c
	s.closers = append(s.closers, done)
	return c, nil
}

func (s *hvSession) close() {
	for _, done := range s.closers {
		done()
	}
}

// inventory reads the host's VMs; for a cluster, every node's, each VM tagged
// with its owner node and the cluster named as the computer (so snapshots stay
// together when a VM moves between nodes).
func (s *hvSession) inventory(ctx context.Context) (*HypervInventory, error) {
	if s.base.Mode != "cluster" {
		c, err := s.conn(ctx, "")
		if err != nil {
			return nil, err
		}
		return s.backend.Inventory(ctx, c)
	}
	nodes, err := s.backend.ClusterNodes(ctx, s.base)
	if err != nil {
		return nil, fmt.Errorf("listing the cluster nodes: %w", err)
	}
	if len(nodes) == 0 {
		return nil, errors.New("the cluster reports no node that is up")
	}
	inv := &HypervInventory{ComputerName: clusterName(s.base.Address), VMs: []HypervVM{}}
	seen := map[string]bool{}
	for _, node := range nodes {
		c, err := s.conn(ctx, node)
		if err != nil {
			return nil, fmt.Errorf("node %s: %w", node, err)
		}
		part, err := s.backend.Inventory(ctx, c)
		if err != nil {
			return nil, fmt.Errorf("node %s: %w", node, err)
		}
		if inv.OS == "" {
			inv.OS = part.OS
		}
		for _, vm := range part.VMs {
			// A VM caught mid-migration may show up twice; the first wins.
			if seen[strings.ToLower(vm.ID)] {
				continue
			}
			seen[strings.ToLower(vm.ID)] = true
			vm.Node = node
			inv.VMs = append(inv.VMs, vm)
		}
	}
	return inv, nil
}

// clusterName is the short, upper-case cluster name used as restic's host.
func clusterName(address string) string {
	return strings.ToUpper(strings.SplitN(address, ".", 2)[0])
}

// --- Inventory ----------------------------------------------------------------

func (a *agent) runHypervInventory(ctx context.Context, t *Task) {
	if a.hyperv == nil || t.Hyperv == nil {
		a.postResult(t.TaskID, TaskResult{Status: "failed", Error: "Hyper-V is not available on this agent"})
		return
	}
	sess, err := a.newSession(ctx, t.Hyperv.Connection)
	if err == nil {
		defer sess.close()
		var inv *HypervInventory
		if inv, err = sess.inventory(ctx); err == nil {
			a.postResult(t.TaskID, TaskResult{Status: "success", HypervInventory: inv})
			log.Printf("Hyper-V inventory %s: %d VMs", t.TaskID, len(inv.VMs))
			return
		}
	}
	a.postResult(t.TaskID, TaskResult{Status: "failed", Error: err.Error()})
}

// --- Backup -------------------------------------------------------------------

func (a *agent) runHypervBackup(ctx context.Context, t *Task) {
	a.runBackupFlow(ctx, t, a.backupVMs, hypervForgetArgs)
}

// hypervForgetArgs applies the retention per VM: the snapshots of a job's VMs
// all carry amber-hyperv, and grouping by host and tags keeps each VM's own.
func hypervForgetArgs(ret *Retention) []string {
	args := forgetArgs(ret)
	return append(args, "--tag", hypervSnapshotTag, "--group-by", "host,tags")
}

// maxParallelVMs caps how many VMs one run backs up at the same time.
const maxParallelVMs = 4

// backupVMs backs up each selected VM into a snapshot of its own, up to
// ParallelVMs at a time. One failing VM doesn't stop the others; the run fails
// if any did, with every outcome in the stats.
func (a *agent) backupVMs(ctx context.Context, t *Task, result *TaskResult, appendLog func(string)) error {
	if a.hyperv == nil || t.Hyperv == nil {
		return errors.New("Hyper-V is not available on this agent")
	}
	sess, err := a.newSession(ctx, t.Hyperv.Connection)
	if err != nil {
		return fmt.Errorf("connecting to the Hyper-V host: %w", err)
	}
	defer sess.close()
	inv, err := sess.inventory(ctx)
	if err != nil {
		return fmt.Errorf("reading the VMs: %w", err)
	}
	vms, missing := selectVMs(inv, t.Hyperv)
	var results []HypervVMResult
	for _, id := range missing {
		appendLog("VM " + id + " not found on " + inv.ComputerName)
		results = append(results, HypervVMResult{VMID: id, Status: "failed", Error: "The VM no longer exists on the host"})
	}
	if len(vms) == 0 && len(missing) == 0 {
		return errors.New("no VM matches the job's selection")
	}

	// Parallel VMs share the log and the progress: both are serialized here.
	var logMu sync.Mutex
	safeLog := func(line string) {
		logMu.Lock()
		defer logMu.Unlock()
		appendLog(line)
	}
	progress := newVMProgress(a, t.TaskID, len(vms))

	parallel := t.Hyperv.ParallelVMs
	if parallel < 1 {
		parallel = 1
	}
	if parallel > maxParallelVMs {
		parallel = maxParallelVMs
	}
	vmResults := make([]HypervVMResult, len(vms))
	sem := make(chan struct{}, parallel)
	var wg sync.WaitGroup
	for i, vm := range vms {
		sem <- struct{}{}
		if ctx.Err() != nil {
			<-sem
			vmResults[i] = HypervVMResult{VMID: vm.ID, Name: vm.Name, Status: "failed", Error: "cancelled"}
			continue
		}
		wg.Add(1)
		go func(i int, vm HypervVM) {
			defer wg.Done()
			defer func() { <-sem }()
			vmResults[i] = a.backupVM(ctx, t, sess, inv, vm, func(done float64, msg map[string]any) {
				progress.report(i, vm.Name, done, msg)
			}, safeLog)
		}(i, vm)
	}
	wg.Wait()
	results = append(results, vmResults...)

	var dataAdded, totalBytes, files float64
	failed := 0
	for _, r := range results {
		if r.Status != "success" {
			failed++
			continue
		}
		result.SnapshotID = r.SnapshotID
		dataAdded += r.DataAdded
		totalBytes += r.TotalBytes
		files++
	}
	result.Stats = map[string]any{
		"dataAdded":           dataAdded,
		"totalBytesProcessed": totalBytes,
		"totalFilesProcessed": files,
		"percentDone":         1,
		"hypervVms":           results,
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if failed > 0 {
		var names []string
		for _, r := range results {
			if r.Status != "success" {
				n := r.Name
				if n == "" {
					n = r.VMID
				}
				names = append(names, n+": "+r.Error)
			}
		}
		return fmt.Errorf("%d of %d VMs failed — %s", failed, len(results), strings.Join(names, "; "))
	}
	return nil
}

// vmProgress folds the progress of VMs backed up side by side into one figure
// for the run: the mean of each VM's share done.
type vmProgress struct {
	a      *agent
	taskID string
	mu     sync.Mutex
	done   []float64
	last   time.Time
}

func newVMProgress(a *agent, taskID string, count int) *vmProgress {
	return &vmProgress{a: a, taskID: taskID, done: make([]float64, count)}
}

func (p *vmProgress) report(i int, name string, done float64, msg map[string]any) {
	p.mu.Lock()
	p.done[i] = done
	if time.Since(p.last) < time.Second {
		p.mu.Unlock()
		return
	}
	p.last = time.Now()
	sum, finished := 0.0, 0
	for _, d := range p.done {
		sum += d
		if d >= 1 {
			finished++
		}
	}
	count := len(p.done)
	p.mu.Unlock()
	p.a.postProgress(p.taskID, map[string]any{
		"percentDone": sum / float64(count),
		"bytesDone":   msg["bytes_done"],
		"totalBytes":  msg["total_bytes"],
		"filesDone":   msg["files_done"],
		"totalFiles":  msg["total_files"],
		"currentVm":   name,
		"vmsDone":     finished,
		"vmCount":     count,
	})
}

// backupVM takes the checkpoint, backs up the VM's files and removes the
// checkpoint again, whatever happened in between.
func (a *agent) backupVM(ctx context.Context, t *Task, sess *hvSession, inv *HypervInventory, vm HypervVM, report func(float64, map[string]any), appendLog func(string)) HypervVMResult {
	started := time.Now()
	res := HypervVMResult{VMID: vm.ID, Name: vm.Name, Status: "failed"}
	logf := func(format string, args ...any) {
		appendLog(fmt.Sprintf("[%s] ", vm.Name) + fmt.Sprintf(format, args...))
	}
	defer report(1, nil)
	conn, err := sess.conn(ctx, vm.Node)
	if err != nil {
		res.Error = "connecting to node " + vm.Node + ": " + err.Error()
		logf("%s", res.Error)
		return res
	}
	if vm.Node != "" {
		logf("on node %s", vm.Node)
	}

	// Checkpoints a crashed run left behind would grow the chain forever.
	if len(vm.StaleCheckpoints) > 0 {
		logf("removing stale checkpoints %s", strings.Join(vm.StaleCheckpoints, ", "))
		if err := a.hyperv.RemoveCheckpoints(ctx, conn, vm.ID, vm.StaleCheckpoints); err != nil {
			logf("could not remove stale checkpoints: %v", err)
		}
	}

	checkpoint := checkpointPrefix + shortID(t.TaskID)
	logf("creating checkpoint %s", checkpoint)
	set, err := a.hyperv.PrepareBackup(ctx, conn, vm.ID, checkpoint, t.Hyperv.CheckpointMode)
	if err != nil {
		res.Error = "checkpoint failed: " + err.Error()
		logf("%s", res.Error)
		return res
	}
	res.Consistency = set.Consistency
	if set.Consistency == consistencyCrash {
		logf("production checkpoint not possible, fell back to a crash-consistent standard checkpoint")
	}
	defer func() {
		// Detached from the task's context: a cancelled backup must still
		// merge its checkpoint.
		cctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if err := a.hyperv.RemoveCheckpoints(cctx, conn, vm.ID, []string{set.Checkpoint}); err != nil {
			logf("removing checkpoint %s failed: %v", set.Checkpoint, err)
		} else {
			logf("checkpoint %s removed", set.Checkpoint)
		}
	}()

	manifestPath, cleanup, err := writeManifest(t, inv, vm, set)
	if err != nil {
		res.Error = "writing the manifest: " + err.Error()
		return res
	}
	defer cleanup()

	paths := []string{manifestPath}
	for _, f := range set.backupFiles() {
		paths = append(paths, a.hyperv.AgentPath(conn, f))
	}
	args := hypervBackupArgs(t, inv.ComputerName, vm, paths, conn.Mode == "local")

	code, err := a.runner.run(ctx, t, args, func(msg map[string]any) {
		switch msg["message_type"] {
		case "status":
			report(jsonNum(msg, "percent_done"), msg)
		case "summary":
			res.SnapshotID, _ = msg["snapshot_id"].(string)
			res.DataAdded = jsonNum(msg, "data_added")
			res.TotalBytes = jsonNum(msg, "total_bytes_processed")
		}
	}, appendLog)
	res.DurationSeconds = time.Since(started).Seconds()
	if ctx.Err() != nil {
		res.Error = "cancelled"
		return res
	}
	if err != nil || code != 0 || res.SnapshotID == "" {
		// A VM backup with unreadable files (exit 3) is not restorable.
		res.Error = fmt.Sprintf("restic backup exited %d: %v", code, err)
		logf("%s", res.Error)
		return res
	}
	res.Status = "success"
	logf("snapshot %s (%s-consistent)", res.SnapshotID, res.Consistency)
	return res
}

// backupFiles are the host paths a VM snapshot holds.
func (s *vmBackupSet) backupFiles() []string {
	var out []string
	for _, d := range s.Disks {
		out = append(out, d.Chain...)
	}
	return append(out, s.ConfigFiles...)
}

func hypervBackupArgs(t *Task, computerName string, vm HypervVM, paths []string, local bool) []string {
	args := []string{"backup", "--json", "--host", computerName,
		"--tag", hypervSnapshotTag, "--tag", vmTag(vm.ID)}
	if o := t.Options; o != nil {
		for _, tag := range o.Tags {
			args = append(args, "--tag", tag)
		}
		if o.Compression != "" {
			args = append(args, "--compression", o.Compression)
		}
		if o.ReadConcurrency > 0 {
			args = append(args, "--read-concurrency", fmt.Sprint(o.ReadConcurrency))
		}
	}
	// The configuration files are open while the VM runs; a VSS snapshot of
	// the host's volumes reads them. Remote disks come over SMB, without VSS.
	if local && supportsFsSnapshot() {
		args = append(args, "--use-fs-snapshot")
	}
	args = append(args, "--")
	return append(args, paths...)
}

// writeManifest stores the VM's manifest where the snapshot picks it up.
func writeManifest(t *Task, inv *HypervInventory, vm HypervVM, set *vmBackupSet) (string, func(), error) {
	dir := filepath.Join(installDir(), "hyperv", shortID(t.TaskID), strings.ToLower(vm.ID))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", func() {}, err
	}
	cleanup := func() { os.RemoveAll(filepath.Dir(dir)) }
	m := vmManifest{
		Format:       manifestFormat,
		ComputerName: inv.ComputerName,
		BackedUpAt:   time.Now().UTC().Format(time.RFC3339),
		VM:           vm,
		Set:          *set,
	}
	data, _ := json.MarshalIndent(m, "", "  ")
	p := filepath.Join(dir, manifestFileName)
	if err := os.WriteFile(p, data, 0o600); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return p, cleanup, nil
}

func shortID(id string) string {
	id = strings.ReplaceAll(id, "-", "")
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

// --- Restore ------------------------------------------------------------------

func (a *agent) runHypervRestore(ctx context.Context, t *Task) {
	var logBuf strings.Builder
	appendLog := func(s string) { logBuf.WriteString(s + "\n") }
	stats, err := a.restoreVM(ctx, t, appendLog)
	switch {
	case ctx.Err() != nil:
		a.cancelTask(t, logBuf.String())
	case err != nil:
		a.postResult(t.TaskID, TaskResult{Status: "failed", Error: err.Error(), Log: logBuf.String(), Stats: stats})
		log.Printf("Hyper-V restore %s failed: %v", t.TaskID, err)
	default:
		a.postResult(t.TaskID, TaskResult{Status: "success", Stats: stats, Log: logBuf.String()})
		log.Printf("Hyper-V restore %s complete", t.TaskID)
	}
}

func (a *agent) restoreVM(ctx context.Context, t *Task, appendLog func(string)) (map[string]any, error) {
	if a.hyperv == nil || t.Hyperv == nil || t.Hyperv.Restore == nil {
		return nil, errors.New("Hyper-V is not available on this agent")
	}
	spec := t.Hyperv.Restore
	conn := t.Hyperv.Connection
	if spec.TargetPath == "" {
		return nil, errors.New("no destination folder on the host")
	}
	sess, err := a.newSession(ctx, conn)
	if err != nil {
		return nil, fmt.Errorf("connecting to the Hyper-V host: %w", err)
	}
	defer sess.close()
	// A cluster restores onto one node (the chosen one, or the first that is up).
	if conn.Mode == "cluster" {
		node := spec.Node
		if node == "" {
			nodes, err := a.hyperv.ClusterNodes(ctx, conn)
			if err != nil || len(nodes) == 0 {
				return nil, fmt.Errorf("listing the cluster nodes: %v", err)
			}
			node = nodes[0]
		}
		if conn, err = sess.conn(ctx, node); err != nil {
			return nil, fmt.Errorf("connecting to node %s: %w", node, err)
		}
		appendLog("restoring onto cluster node " + node)
	}

	// A known name is checked before anything is restored (the manifest
	// supplies the default name, checked once it is read).
	if spec.NewName != "" {
		existing := a.hyperv.AgentPath(conn, joinHostPath(spec.TargetPath, safeFileName(spec.NewName)))
		if _, err := os.Stat(existing); err == nil {
			return nil, fmt.Errorf("%s already exists; choose another name or folder", joinHostPath(spec.TargetPath, safeFileName(spec.NewName)))
		}
	}

	// 1. The snapshot's files go into a staging folder next to the target.
	stagingHost := joinHostPath(spec.TargetPath, ".amber-restore-"+shortID(t.TaskID))
	staging := a.hyperv.AgentPath(conn, stagingHost)
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return nil, fmt.Errorf("creating %s: %w", stagingHost, err)
	}
	defer os.RemoveAll(staging)
	appendLog("restoring snapshot " + t.SnapshotID + " into " + stagingHost)
	stats, err := a.restoreOnce(ctx, t, restoreArgsFor(t.SnapshotID, staging, nil, t.RestoreOptions), appendLog)
	if err != nil {
		return nil, err
	}

	// 2. The manifest says what the files are.
	files, err := listFiles(staging)
	if err != nil {
		return stats, err
	}
	manifestFile := findRestored(files, manifestFileName)
	if manifestFile == "" {
		return stats, errors.New("the snapshot holds no VM manifest (amber-vm.json); it is not a Hyper-V backup")
	}
	var m vmManifest
	data, err := os.ReadFile(manifestFile)
	if err == nil {
		err = json.Unmarshal(data, &m)
	}
	if err != nil {
		return stats, fmt.Errorf("reading the VM manifest: %w", err)
	}
	if !strings.EqualFold(m.VM.ID, spec.VMID) {
		return stats, fmt.Errorf("the snapshot holds VM %s, not %s", m.VM.ID, spec.VMID)
	}

	name := spec.NewName
	if name == "" {
		name = m.VM.Name
		if !spec.ReplaceOriginal {
			name += " (restored)"
		}
	}

	// 3. Move the files into their final place: <target>\<name>\…
	vmDirHost := joinHostPath(spec.TargetPath, safeFileName(name))
	disksDirHost := joinHostPath(vmDirHost, "Virtual Hard Disks")
	if _, err := os.Stat(a.hyperv.AgentPath(conn, vmDirHost)); err == nil {
		return stats, fmt.Errorf("%s already exists; choose another name or folder", vmDirHost)
	}
	if err := os.MkdirAll(a.hyperv.AgentPath(conn, disksDirHost), 0o700); err != nil {
		return stats, err
	}
	var restoredDisks []vmDiskChain
	used := map[string]bool{}
	for _, d := range m.Set.Disks {
		nd := d
		nd.Chain = nil
		for _, hostPath := range d.Chain {
			src := findRestoredPath(files, hostPath)
			if src == "" {
				return stats, fmt.Errorf("disk %s is missing from the snapshot", hostPath)
			}
			dstName := uniqueName(used, baseOfHostPath(hostPath))
			dstHost := joinHostPath(disksDirHost, dstName)
			if err := os.Rename(src, a.hyperv.AgentPath(conn, dstHost)); err != nil {
				return stats, fmt.Errorf("moving %s: %w", dstName, err)
			}
			nd.Chain = append(nd.Chain, dstHost)
		}
		restoredDisks = append(restoredDisks, nd)
	}
	if len(m.Set.ConfigFiles) > 0 {
		// Kept for a manual Import-VM; the VM is rebuilt from the manifest.
		cfgHost := joinHostPath(vmDirHost, "Backed-up configuration")
		os.MkdirAll(a.hyperv.AgentPath(conn, cfgHost), 0o700)
		for _, f := range append([]string{"manifest"}, m.Set.ConfigFiles...) {
			src := manifestFile
			name := manifestFileName
			if f != "manifest" {
				src, name = findRestoredPath(files, f), baseOfHostPath(f)
			}
			if src != "" {
				os.Rename(src, a.hyperv.AgentPath(conn, joinHostPath(cfgHost, name)))
			}
		}
	}

	out := map[string]any{"bytesDone": stats["bytesDone"], "totalBytes": stats["totalBytes"], "percentDone": 1}
	restoreInfo := map[string]any{"sourceVmId": m.VM.ID, "sourceName": m.VM.Name, "path": vmDirHost}
	out["hypervRestore"] = restoreInfo

	if spec.Action == "disks" {
		appendLog(fmt.Sprintf("disks of %s restored to %s", m.VM.Name, disksDirHost))
		restoreInfo["action"] = "disks"
		return out, nil
	}

	// 4. Register the VM.
	if spec.ReplaceOriginal {
		appendLog("removing the original VM " + m.VM.Name + " (its files stay on disk)")
		if err := a.hyperv.RemoveVM(ctx, conn, m.VM.ID); err != nil {
			return out, fmt.Errorf("removing the original VM: %w", err)
		}
	}
	vm, err := a.hyperv.RegisterVM(ctx, conn, registerRequest{
		Manifest:       m,
		Name:           name,
		VMPath:         vmDirHost,
		Disks:          restoredDisks,
		Start:          spec.Start,
		ConnectNetwork: spec.ConnectNetwork,
		KeepMac:        spec.ReplaceOriginal,
		ClusterRole:    t.Hyperv.Connection.Mode == "cluster",
	})
	if err != nil {
		return out, fmt.Errorf("registering the VM: %w", err)
	}
	for _, w := range vm.Warnings {
		appendLog("warning: " + w)
	}
	appendLog(fmt.Sprintf("VM %q registered as %s", vm.Name, vm.ID))
	restoreInfo["action"] = "vm"
	restoreInfo["vmId"] = vm.ID
	restoreInfo["name"] = vm.Name
	restoreInfo["replacedOriginal"] = spec.ReplaceOriginal
	return out, nil
}

// --- Host path helpers ---------------------------------------------------------
//
// Paths on the Hyper-V host are Windows paths (D:\VMs\a.vhdx), whatever the
// agent runs on; the mock uses plain local paths. These helpers keep the
// host's separator.

func hostSep(p string) string {
	if strings.Contains(p, `\`) || (len(p) >= 2 && p[1] == ':') {
		return `\`
	}
	return "/"
}

func joinHostPath(dir, name string) string {
	sep := hostSep(dir)
	return strings.TrimRight(dir, `\/`) + sep + name
}

func baseOfHostPath(p string) string {
	if i := strings.LastIndexAny(p, `\/`); i >= 0 {
		return p[i+1:]
	}
	return p
}

// safeFileName makes a VM name usable as a folder name.
func safeFileName(name string) string {
	r := strings.NewReplacer(`\`, "_", "/", "_", ":", "_", "*", "_", "?", "_", `"`, "_", "<", "_", ">", "_", "|", "_")
	return strings.TrimSpace(r.Replace(name))
}

func uniqueName(used map[string]bool, name string) string {
	candidate := name
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 2; used[strings.ToLower(candidate)]; i++ {
		candidate = fmt.Sprintf("%s-%d%s", stem, i, ext)
	}
	used[strings.ToLower(candidate)] = true
	return candidate
}

func listFiles(root string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			out = append(out, p)
		}
		return nil
	})
	return out, err
}

func findRestored(files []string, base string) string {
	for _, f := range files {
		if strings.EqualFold(filepath.Base(f), base) {
			return f
		}
	}
	return ""
}

// findRestoredPath finds the restored copy of a host file. How restic lays out
// a path in the snapshot depends on how it was read (D:\… locally, a UNC path
// for a remote host), so the restored files are matched by their trailing
// path components: the candidate sharing the longest suffix with the host path
// wins.
func findRestoredPath(files []string, hostPath string) string {
	want := splitPath(hostPath)
	best, bestLen := "", 0
	for _, f := range files {
		got := splitPath(f)
		n := 0
		for n < len(want) && n < len(got) && strings.EqualFold(want[len(want)-1-n], got[len(got)-1-n]) {
			n++
		}
		if n > bestLen {
			best, bestLen = f, n
		}
	}
	return best
}

func splitPath(p string) []string {
	return strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' })
}
