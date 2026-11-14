package main

// A simulated Proxmox VE cluster for development and tests, enabled with
// AMBER_PROXMOX_MOCK=<dir>. State lives in <dir>/state.json; VM disks are
// plain files (<dir>/disks/<vmid>/<key>.img) and CT volumes directories
// (<dir>/disks/<vmid>/<key>/), so backups and restores run through real
// restic. Snapshots are copies (<dir>/snaps/<vmid>/<snap>/…).
//
// The agent is node "self" (AMBER_PROXMOX_MOCK_NODE overrides it). Change
// tracking: bitmaps of running VMs collect the extents written through
// WriteDisk; Restart drops them like a QEMU restart. vzdump is simulated by an
// archive the mock writes and `cat`s (a VMA from the real writer, a CT tar);
// restores parse what they receive and keep a copy in <dir>/restored/.
//
// On first use it seeds: VM 100 "web" (running, guest agent, two disks on
// zfs), CT 101 "db" (running, unprivileged, rootfs + mp0 on zfs), VM 102
// "legacy" (stopped, raw disk on dir storage → vzdump) on pve1, and VM 200
// "remote" on pve2.

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type mockPveGuest struct {
	VMID      int      `json:"vmid"`
	Type      string   `json:"type"`
	Node      string   `json:"node"`
	Status    string   `json:"status"`
	Pool      string   `json:"pool,omitempty"`
	Tags      string   `json:"tags,omitempty"`
	Config    string   `json:"config"`
	Lock      string   `json:"lock,omitempty"`
	Snapshots []string `json:"snapshots,omitempty"`
	// bitmap name → disk key → dirty extents (running VMs only).
	Bitmaps map[string]map[string][]pveExtent `json:"bitmaps,omitempty"`
	// Knobs.
	FailSnapshot bool `json:"failSnapshot,omitempty"`
}

type mockPveState struct {
	ClusterName string          `json:"clusterName"`
	Nodes       []string        `json:"nodes"`
	StorageCfg  string          `json:"storageCfg"`
	Guests      []*mockPveGuest `json:"guests"`
	NextID      int             `json:"nextId"`
}

type mockPve struct {
	dir string
	mu  sync.Mutex
	// Images AttachImage handed out and not yet detached.
	attached int
}

func newMockPve(dir string) *mockPve { return &mockPve{dir: dir} }

func (m *mockPve) Name() string { return "mock" }

func (m *mockPve) self() string { return getenv("AMBER_PROXMOX_MOCK_NODE", "pve1") }

const mockStorageCfg = `dir: local
	path /var/lib/vz
	content iso,vztmpl,backup,images,rootdir

zfspool: local-zfs
	pool rpool/data
	content images,rootdir
	sparse

nfs: nas
	export /export/pve
	server 10.0.0.5
	path /mnt/pve/nas
	content images,backup
`

func (m *mockPve) statePath() string { return filepath.Join(m.dir, "state.json") }

func (m *mockPve) load() (*mockPveState, error) {
	data, err := os.ReadFile(m.statePath())
	if os.IsNotExist(err) {
		return m.seed()
	}
	if err != nil {
		return nil, err
	}
	var s mockPveState
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("mock state: %w", err)
	}
	return &s, nil
}

func (m *mockPve) save(s *mockPveState) error {
	data, _ := json.MarshalIndent(s, "", "  ")
	return os.WriteFile(m.statePath(), data, 0o600)
}

func (m *mockPve) diskPath(vmid int, key string) string {
	return filepath.Join(m.dir, "disks", strconv.Itoa(vmid), key+".img")
}

func (m *mockPve) volDir(vmid int, key string) string {
	return filepath.Join(m.dir, "disks", strconv.Itoa(vmid), key)
}

func (m *mockPve) snapDir(vmid int, snap string) string {
	return filepath.Join(m.dir, "snaps", strconv.Itoa(vmid), snap)
}

func mockRandom(seed int64, n int) []byte {
	b := make([]byte, n)
	rand.New(rand.NewSource(seed)).Read(b)
	return b
}

func (m *mockPve) seed() (*mockPveState, error) {
	s := &mockPveState{ClusterName: "mockcluster", Nodes: []string{"pve1", "pve2"}, StorageCfg: mockStorageCfg, NextID: 300}
	add := func(g *mockPveGuest) { s.Guests = append(s.Guests, g) }
	add(&mockPveGuest{VMID: 100, Type: pveTypeQemu, Node: "pve1", Status: "running", Pool: "prod", Tags: "web;linux", Config: strings.Join([]string{
		"name: web", "agent: 1", "cores: 2", "memory: 2048", "ostype: l26", "bios: ovmf",
		"efidisk0: local-zfs:vm-100-disk-1,efitype=4m,size=1M",
		"scsi0: local-zfs:vm-100-disk-0,iothread=1,size=40M",
		"ide2: local:iso/debian.iso,media=cdrom",
		"net0: virtio=BC:24:11:00:00:01,bridge=vmbr0",
	}, "\n") + "\n"})
	add(&mockPveGuest{VMID: 101, Type: pveTypeLXC, Node: "pve1", Status: "running", Config: strings.Join([]string{
		"hostname: db", "arch: amd64", "cores: 1", "memory: 512", "ostype: debian", "unprivileged: 1",
		"rootfs: local-zfs:subvol-101-disk-0,size=8G",
		"mp0: local-zfs:subvol-101-disk-1,mp=/data,backup=1,size=2G",
		"mp1: /srv/host,mp=/hostdata",
		"net0: name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:02,ip=dhcp,type=veth",
	}, "\n") + "\n"})
	add(&mockPveGuest{VMID: 102, Type: pveTypeQemu, Node: "pve1", Status: "stopped", Config: strings.Join([]string{
		"name: legacy", "cores: 1", "memory: 1024",
		"virtio0: local:102/vm-102-disk-0.raw,size=8M",
	}, "\n") + "\n"})
	add(&mockPveGuest{VMID: 200, Type: pveTypeQemu, Node: "pve2", Status: "running", Config: strings.Join([]string{
		"name: remote", "cores: 1", "memory: 1024", "scsi0: local-zfs:vm-200-disk-0,size=4M",
	}, "\n") + "\n"})

	for _, g := range s.Guests {
		for _, d := range guestDisks(g.Type, parsePveConfig(g.Config)) {
			if d.Storage == "" {
				continue
			}
			if g.Type == pveTypeLXC {
				dir := m.volDir(g.VMID, d.Key)
				if err := os.MkdirAll(dir, 0o755); err != nil {
					return nil, err
				}
				if d.Key == "rootfs" {
					os.MkdirAll(filepath.Join(dir, "etc"), 0o755)
					os.MkdirAll(filepath.Join(dir, "tmp"), 0o755)
					os.WriteFile(filepath.Join(dir, "etc", "hostname"), []byte("db\n"), 0o644)
					os.WriteFile(filepath.Join(dir, "etc", "app.conf"), []byte("setting=1\n"), 0o640)
					os.WriteFile(filepath.Join(dir, "tmp", "scratch"), []byte("temporary"), 0o644)
				} else {
					os.WriteFile(filepath.Join(dir, "table.db"), mockRandom(int64(g.VMID), 300_000), 0o600)
				}
				continue
			}
			p := m.diskPath(g.VMID, d.Key)
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return nil, err
			}
			data := mockRandom(int64(g.VMID)*31+int64(len(d.Key)), int(d.SizeBytes))
			// Leave a zero run, so zero clusters/blocks are exercised.
			if len(data) > 3<<20 {
				clear(data[1<<20 : 3<<20])
			}
			if err := os.WriteFile(p, data, 0o600); err != nil {
				return nil, err
			}
		}
	}
	if err := os.MkdirAll(m.dir, 0o755); err != nil {
		return nil, err
	}
	return s, m.save(s)
}

func (m *mockPve) guest(s *mockPveState, vmid int) (*mockPveGuest, error) {
	for _, g := range s.Guests {
		if g.VMID == vmid {
			return g, nil
		}
	}
	return nil, errGuestNotFound
}

// update loads, mutates and saves the state.
func (m *mockPve) update(fn func(*mockPveState) error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.load()
	if err != nil {
		return err
	}
	if err := fn(s); err != nil {
		return err
	}
	return m.save(s)
}

func (m *mockPve) read() (*mockPveState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.load()
}

// configText renders a guest's config as PVE writes it (with lock and snapshot sections).
func (g *mockPveGuest) configText() string {
	text := g.Config
	if g.Lock != "" {
		text += "lock: " + g.Lock + "\n"
	}
	for _, s := range g.Snapshots {
		text += "\n[" + s + "]\n" + g.Config
	}
	return text
}

func (m *mockPve) Info(ctx context.Context) (*ProxmoxAgentInfo, error) {
	s, err := m.read()
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte("mock-ca:" + s.ClusterName))
	name := s.ClusterName
	return &ProxmoxAgentInfo{ClusterID: hex.EncodeToString(sum[:]), ClusterName: &name, Node: m.self(),
		PveVersion: "pve-manager/8.2.4/mock (running kernel: mock)"}, nil
}

func (m *mockPve) Inventory(ctx context.Context) (*ProxmoxInventory, error) {
	s, err := m.read()
	if err != nil {
		return nil, err
	}
	storages := parseStorageCfg(s.StorageCfg)
	name := s.ClusterName
	inv := &ProxmoxInventory{ClusterName: &name, PveVersion: "pve-manager/8.2.4/mock", ReadBy: m.self(),
		Nodes: []ProxmoxNodeInfo{}, Storages: []ProxmoxStorage{}, Guests: []ProxmoxGuest{}}
	for _, n := range s.Nodes {
		inv.Nodes = append(inv.Nodes, ProxmoxNodeInfo{Name: n, Online: true})
	}
	for _, id := range sortedKeys(storages) {
		inv.Storages = append(inv.Storages, storageView(storages[id]))
	}
	for _, g := range s.Guests {
		pg := ProxmoxGuest{VMID: g.VMID, Type: g.Type, Node: g.Node, Status: g.Status, Pool: g.Pool, Tags: splitList(g.Tags)}
		inv.Guests = append(inv.Guests, buildGuest(pg, parsePveConfig(g.configText()), storages))
	}
	return inv, nil
}

func (m *mockPve) LocateGuest(ctx context.Context, vmid int) (string, string, error) {
	s, err := m.read()
	if err != nil {
		return "", "", err
	}
	g, err := m.guest(s, vmid)
	if err != nil {
		return "", "", err
	}
	return g.Node, g.Type, nil
}

func (m *mockPve) GuestConfig(ctx context.Context, typ string, vmid int) (*pveConfig, error) {
	s, err := m.read()
	if err != nil {
		return nil, err
	}
	g, err := m.guest(s, vmid)
	if err != nil {
		return nil, err
	}
	return parsePveConfig(g.configText()), nil
}

func (m *mockPve) GuestStatus(ctx context.Context, typ string, vmid int) (string, error) {
	s, err := m.read()
	if err != nil {
		return "", err
	}
	g, err := m.guest(s, vmid)
	if err != nil {
		return "", err
	}
	return g.Status, nil
}

func (m *mockPve) Storages(ctx context.Context) (map[string]*pveStorageCfg, error) {
	s, err := m.read()
	if err != nil {
		return nil, err
	}
	return parseStorageCfg(s.StorageCfg), nil
}

func (m *mockPve) Snapshot(ctx context.Context, typ string, vmid int, name string) error {
	return m.update(func(s *mockPveState) error {
		g, err := m.guest(s, vmid)
		if err != nil {
			return err
		}
		if g.Lock != "" {
			return fmt.Errorf("VM is locked (%s)", g.Lock)
		}
		if g.FailSnapshot {
			return errors.New("snapshot failed (mock)")
		}
		dst := m.snapDir(vmid, name)
		for _, d := range guestDisks(g.Type, parsePveConfig(g.Config)) {
			if d.Storage == "" {
				continue
			}
			if g.Type == pveTypeLXC {
				if err := copyTree(m.volDir(vmid, d.Key), filepath.Join(dst, d.Key)); err != nil {
					return err
				}
			} else if err := copyFile(m.diskPath(vmid, d.Key), filepath.Join(dst, d.Key+".img")); err != nil {
				return err
			}
		}
		g.Snapshots = append(g.Snapshots, name)
		return nil
	})
}

func (m *mockPve) DeleteSnapshot(ctx context.Context, typ string, vmid int, name string) error {
	return m.update(func(s *mockPveState) error {
		g, err := m.guest(s, vmid)
		if err != nil {
			return err
		}
		if g.Lock != "" {
			return fmt.Errorf("VM is locked (%s)", g.Lock)
		}
		var keep []string
		for _, sn := range g.Snapshots {
			if sn != name {
				keep = append(keep, sn)
			}
		}
		g.Snapshots = keep
		return os.RemoveAll(m.snapDir(vmid, name))
	})
}

func (m *mockPve) SetLock(ctx context.Context, typ string, vmid int, lock string) error {
	return m.update(func(s *mockPveState) error {
		g, err := m.guest(s, vmid)
		if err != nil {
			return err
		}
		g.Lock = lock
		return nil
	})
}

func (m *mockPve) VzdumpCommand(ctx context.Context, typ string, vmid int, mode string) ([]string, error) {
	s, err := m.read()
	if err != nil {
		return nil, err
	}
	g, err := m.guest(s, vmid)
	if err != nil {
		return nil, err
	}
	out := filepath.Join(m.dir, "vzdump", vzdumpFileName(typ, vmid))
	os.MkdirAll(filepath.Dir(out), 0o755)
	f, err := os.Create(out)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	cfg := parsePveConfig(g.Config)
	if typ == pveTypeLXC {
		if err := m.writeCTTar(f, g, cfg); err != nil {
			return nil, err
		}
	} else if err := m.writeVMA(f, g, cfg); err != nil {
		return nil, err
	}
	return []string{"cat", out}, nil
}

func (m *mockPve) writeVMA(w io.Writer, g *mockPveGuest, cfg *pveConfig) error {
	var disks []ProxmoxGuestDisk
	var devs []vmaDevice
	for _, d := range guestDisks(pveTypeQemu, cfg) {
		if !d.Backup || d.Storage == "" {
			continue
		}
		fi, err := os.Stat(m.diskPath(g.VMID, d.Key))
		if err != nil {
			return err
		}
		disks = append(disks, d)
		devs = append(devs, vmaDevice{Name: vmaDeviceName(d.Key), Size: fi.Size()})
	}
	conf := vmaConfigText(&pveManifest{Disks: disks, Config: cfg.currentConfigText()})
	vw, err := newVMAWriter(w, []vmaConfig{{Name: "qemu-server.conf", Data: []byte(conf)}}, devs)
	if err != nil {
		return err
	}
	for i, d := range disks {
		f, err := os.Open(m.diskPath(g.VMID, d.Key))
		if err != nil {
			return err
		}
		_, err = io.Copy(vw.Device(i+1), f)
		f.Close()
		if err != nil {
			return err
		}
	}
	return vw.Close()
}

// writeCTTar writes a vzdump-like CT archive: pct.conf, then the rootfs with
// the mount points' contents at their paths.
func (m *mockPve) writeCTTar(w io.Writer, g *mockPveGuest, cfg *pveConfig) error {
	tw := tar.NewWriter(w)
	conf := []byte(cfg.currentConfigText())
	tw.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: "./etc/vzdump/pct.conf", Mode: 0o600, Size: int64(len(conf)), ModTime: time.Now()})
	tw.Write(conf)
	for _, d := range guestDisks(pveTypeLXC, cfg) {
		if !d.Backup || d.Storage == "" {
			continue
		}
		base := m.volDir(g.VMID, d.Key)
		prefix := "." + strings.TrimSuffix(d.MountPath, "/")
		err := filepath.WalkDir(base, func(p string, de fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(base, p)
			name := prefix + "/" + filepath.ToSlash(rel)
			if rel == "." {
				name = prefix + "/"
			}
			info, err := de.Info()
			if err != nil {
				return err
			}
			h, err := tar.FileInfoHeader(info, "")
			if err != nil {
				return err
			}
			h.Name = name
			if de.IsDir() && !strings.HasSuffix(h.Name, "/") {
				h.Name += "/"
			}
			if err := tw.WriteHeader(h); err != nil {
				return err
			}
			if de.Type().IsRegular() {
				f, err := os.Open(p)
				if err != nil {
					return err
				}
				defer f.Close()
				_, err = io.Copy(tw, f)
				return err
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	return tw.Close()
}

type mockDisk struct {
	f *os.File
	n int64
}

func (d *mockDisk) ReadAt(p []byte, off int64) (int, error) { return d.f.ReadAt(p, off) }
func (d *mockDisk) Size() int64                             { return d.n }
func (d *mockDisk) Close() error                            { return d.f.Close() }

func (m *mockPve) OpenSnapshotDisk(ctx context.Context, vmid int, d ProxmoxGuestDisk, st *pveStorageCfg, snap string) (pveDiskReader, error) {
	f, err := os.Open(filepath.Join(m.snapDir(vmid, snap), d.Key+".img"))
	if err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	return &mockDisk{f: f, n: fi.Size()}, nil
}

// MountSnapshotVolume copies the snapshot (a real agent bind-mounts it).
func (m *mockPve) MountSnapshotVolume(ctx context.Context, vmid int, d ProxmoxGuestDisk, st *pveStorageCfg, snap, target string) (func() error, error) {
	if err := copyTree(filepath.Join(m.snapDir(vmid, snap), d.Key), target); err != nil {
		return nil, err
	}
	return func() error {
		entries, _ := os.ReadDir(target)
		for _, e := range entries {
			os.RemoveAll(filepath.Join(target, e.Name()))
		}
		return nil
	}, nil
}

func (m *mockPve) AddBitmaps(ctx context.Context, vmid int, keys []string, name string) error {
	return m.update(func(s *mockPveState) error {
		g, err := m.guest(s, vmid)
		if err != nil {
			return err
		}
		if g.Status != "running" {
			return errors.New("VM is not running")
		}
		if g.Bitmaps == nil {
			g.Bitmaps = map[string]map[string][]pveExtent{}
		}
		if _, dup := g.Bitmaps[name]; dup {
			return fmt.Errorf("bitmap %s already exists", name)
		}
		g.Bitmaps[name] = map[string][]pveExtent{}
		for _, k := range keys {
			g.Bitmaps[name][k] = []pveExtent{}
		}
		return nil
	})
}

func (m *mockPve) RemoveBitmaps(ctx context.Context, vmid int, keys []string, name string) error {
	return m.update(func(s *mockPveState) error {
		g, err := m.guest(s, vmid)
		if err != nil {
			return err
		}
		if _, ok := g.Bitmaps[name]; !ok {
			return errNoBitmap
		}
		delete(g.Bitmaps, name)
		return nil
	})
}

func (m *mockPve) DirtyExtents(ctx context.Context, vmid int, key, bitmap string) ([]pveExtent, error) {
	s, err := m.read()
	if err != nil {
		return nil, err
	}
	g, err := m.guest(s, vmid)
	if err != nil {
		return nil, err
	}
	bm, ok := g.Bitmaps[bitmap]
	if !ok || g.Status != "running" {
		return nil, errNoBitmap
	}
	ext, ok := bm[key]
	if !ok {
		return nil, errNoBitmap
	}
	return ext, nil
}

func (m *mockPve) NextVMID(ctx context.Context) (int, error) {
	var id int
	err := m.update(func(s *mockPveState) error {
		for {
			if _, err := m.guest(s, s.NextID); err != nil {
				break
			}
			s.NextID++
		}
		id = s.NextID
		return nil
	})
	return id, err
}

func (m *mockPve) setStatus(vmid int, status string) error {
	return m.update(func(s *mockPveState) error {
		g, err := m.guest(s, vmid)
		if err != nil {
			return err
		}
		g.Status = status
		if status != "running" {
			g.Bitmaps = nil // QEMU's bitmaps die with the process
		}
		return nil
	})
}

func (m *mockPve) StopGuest(ctx context.Context, typ string, vmid int) error {
	return m.setStatus(vmid, "stopped")
}

func (m *mockPve) StartGuest(ctx context.Context, typ string, vmid int) error {
	return m.setStatus(vmid, "running")
}

var nameLineRE = regexp.MustCompile(`(?m)^(name|hostname):.*\n?`)

func (m *mockPve) SetName(ctx context.Context, typ string, vmid int, name string) error {
	return m.update(func(s *mockPveState) error {
		g, err := m.guest(s, vmid)
		if err != nil {
			return err
		}
		key := "name"
		if typ == pveTypeLXC {
			key = "hostname"
		}
		g.Config = key + ": " + name + "\n" + nameLineRE.ReplaceAllString(g.Config, "")
		return nil
	})
}

var qmdumpLineRE = regexp.MustCompile(`^#qmdump#map:([^:]+):([^:]+):([^:]*):([^:]*):$`)

// RestoreGuest parses the archive like qmrestore / pct restore would and
// registers the guest on this node.
func (m *mockPve) RestoreGuest(ctx context.Context, typ string, vmid int, opts pveRestoreOpts, archive io.Reader, onLog func(string)) error {
	keep := filepath.Join(m.dir, "restored", vzdumpFileName(typ, vmid))
	os.MkdirAll(filepath.Dir(keep), 0o755)
	f, err := os.Create(keep)
	if err != nil {
		return err
	}
	defer f.Close()
	src := io.TeeReader(archive, f)

	s, err := m.read()
	if err != nil {
		return err
	}
	if g, err := m.guest(s, vmid); err == nil && !opts.Force {
		return fmt.Errorf("unable to restore %s %d - already exists on node '%s'", typ, vmid, g.Node)
	}
	tmp := filepath.Join(m.dir, "disks", strconv.Itoa(vmid)+".restore")
	os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	var config string
	if typ == pveTypeQemu {
		config, err = m.restoreVMA(src, vmid, tmp, opts)
	} else {
		config, err = m.restoreCTTar(src, vmid, tmp, opts)
	}
	io.Copy(io.Discard, src)
	if err != nil {
		os.RemoveAll(tmp)
		return err
	}
	final := filepath.Join(m.dir, "disks", strconv.Itoa(vmid))
	os.RemoveAll(final)
	if err := os.Rename(tmp, final); err != nil {
		return err
	}
	onLog(fmt.Sprintf("mock: restored %s %d", typ, vmid))
	return m.update(func(s *mockPveState) error {
		var rest []*mockPveGuest
		for _, g := range s.Guests {
			if g.VMID != vmid {
				rest = append(rest, g)
			}
		}
		s.Guests = append(rest, &mockPveGuest{VMID: vmid, Type: typ, Node: m.self(), Status: "stopped", Config: config})
		return nil
	})
}

func (m *mockPve) restoreVMA(src io.Reader, vmid int, dir string, opts pveRestoreOpts) (string, error) {
	files := map[int]*os.File{}
	defer func() {
		for _, f := range files {
			f.Close()
		}
	}()
	var arch *vmaArchive
	arch, err := readVMA(src, func(dev int, cluster uint32, data []byte) error {
		f := files[dev]
		if f == nil {
			return fmt.Errorf("cluster before device %d was opened", dev)
		}
		size := arch.Devices[dev].Size
		off := int64(cluster) * vmaClusterSize
		n := int64(len(data))
		if off+n > size {
			n = size - off
		}
		_, err := f.WriteAt(data[:n], off)
		return err
	}, func(a *vmaArchive) error {
		arch = a
		for id, d := range a.Devices {
			key := strings.TrimSuffix(strings.TrimPrefix(d.Name, "drive-"), "-backup")
			f, err := os.Create(filepath.Join(dir, key+".img"))
			if err != nil {
				return err
			}
			if err := f.Truncate(d.Size); err != nil {
				return err
			}
			files[id] = f
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	conf, ok := arch.Configs["qemu-server.conf"]
	if !ok {
		return "", errors.New("archive has no qemu-server.conf")
	}
	// Map lines tell where each disk came from; volids are rewritten.
	storageOf := map[string]string{}
	var lines []string
	for _, l := range strings.Split(string(conf), "\n") {
		if mm := qmdumpLineRE.FindStringSubmatch(l); mm != nil {
			storageOf[mm[1]] = mm[3]
			continue
		}
		lines = append(lines, l)
	}
	cfg := parsePveConfig(strings.Join(lines, "\n"))
	out := strings.Join(lines, "\n")
	n := 0
	for _, d := range guestDisks(pveTypeQemu, cfg) {
		st, ok := storageOf[d.Key]
		if !ok {
			continue
		}
		if opts.Storage != "" {
			st = opts.Storage
		}
		out = strings.Replace(out, d.Key+": "+d.Volid, fmt.Sprintf("%s: %s:vm-%d-disk-%d", d.Key, st, vmid, n), 1)
		n++
	}
	return out, nil
}

func (m *mockPve) restoreCTTar(src io.Reader, vmid int, dir string, opts pveRestoreOpts) (string, error) {
	root := filepath.Join(dir, "rootfs")
	os.MkdirAll(root, 0o755)
	tr := tar.NewReader(src)
	var conf []byte
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		name := strings.TrimPrefix(h.Name, "./")
		if name == "etc/vzdump/pct.conf" {
			conf, _ = io.ReadAll(tr)
			continue
		}
		if name == "" || strings.HasPrefix(name, "etc/vzdump") || strings.Contains(name, "..") {
			continue
		}
		p := filepath.Join(root, filepath.FromSlash(name))
		switch h.Typeflag {
		case tar.TypeDir:
			os.MkdirAll(p, 0o755)
		case tar.TypeReg:
			os.MkdirAll(filepath.Dir(p), 0o755)
			f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(h.Mode)&0o777)
			if err != nil {
				return "", err
			}
			_, err = io.Copy(f, tr)
			f.Close()
			if err != nil {
				return "", err
			}
		case tar.TypeSymlink:
			os.MkdirAll(filepath.Dir(p), 0o755)
			os.Symlink(h.Linkname, p)
		}
		// Owners: a real pct restore keeps them; the mock records them.
		m.recordOwner(dir, name, h.Uid, h.Gid)
	}
	if conf == nil {
		return "", errors.New("archive has no ./etc/vzdump/pct.conf")
	}
	return string(conf), nil
}

// recordOwner keeps the owners a restore received (the mock can't chown).
func (m *mockPve) recordOwner(dir, name string, uid, gid int) {
	f, err := os.OpenFile(filepath.Join(dir, "owners.txt"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %d %d\n", name, uid, gid)
}

func (m *mockPve) CTRootfs(ctx context.Context, vmid int) (string, func() error, error) {
	s, err := m.read()
	if err != nil {
		return "", nil, err
	}
	g, err := m.guest(s, vmid)
	if err != nil {
		return "", nil, err
	}
	if g.Type != pveTypeLXC {
		return "", nil, errors.New("not a container")
	}
	// Restored CTs keep their files in rootfs/; seeded ones in the rootfs volume.
	p := filepath.Join(m.dir, "disks", strconv.Itoa(vmid), "rootfs")
	return p, func() error { return nil }, nil
}

// --- Test helpers -----------------------------------------------------------------

// WriteDisk changes a VM disk and marks the range in every bitmap, as QEMU would.
func (m *mockPve) WriteDisk(vmid int, key string, off int64, data []byte) error {
	f, err := os.OpenFile(m.diskPath(vmid, key), os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	_, err = f.WriteAt(data, off)
	f.Close()
	if err != nil {
		return err
	}
	return m.update(func(s *mockPveState) error {
		g, err := m.guest(s, vmid)
		if err != nil {
			return err
		}
		for _, bm := range g.Bitmaps {
			if _, ok := bm[key]; ok {
				bm[key] = append(bm[key], pveExtent{Offset: off, Length: int64(len(data))})
			}
		}
		return nil
	})
}

// MoveGuest simulates a migration.
func (m *mockPve) MoveGuest(vmid int, node string) error {
	return m.update(func(s *mockPveState) error {
		g, err := m.guest(s, vmid)
		if err != nil {
			return err
		}
		g.Node = node
		g.Bitmaps = nil
		return nil
	})
}

// --- File helpers ---------------------------------------------------------------------

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	fi, err := in.Stat()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fi.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chtimes(dst, fi.ModTime(), fi.ModTime())
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, de fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		info, err := de.Info()
		if err != nil {
			return err
		}
		switch {
		case de.IsDir():
			return os.MkdirAll(target, info.Mode().Perm()|0o700)
		case de.Type()&fs.ModeSymlink != 0:
			l, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(l, target)
		default:
			return copyFile(p, target)
		}
	})
}

// --- Disk images: vm-files and live restores ---------------------------------------

// guestFSDir holds the simulated filesystems of a VM disk: <dir>/guestfs/<vmid>/<key>/p<N>/.
func (m *mockPve) guestFSDir(vmid int, key string) string {
	return filepath.Join(m.dir, "guestfs", strconv.Itoa(vmid), key)
}

// AttachImage checks that the served image equals the VM's disk byte for
// byte, then hands out the simulated filesystems of that disk as partitions.
func (m *mockPve) AttachImage(ctx context.Context, vmid int, key, image, workdir string) ([]pveGuestPartition, []string, func() error, error) {
	same, err := sameFileContent(image, m.diskPath(vmid, key))
	if err != nil {
		return nil, nil, nil, err
	}
	if !same {
		return nil, nil, nil, fmt.Errorf("mock: the image of VM %d disk %s differs from the disk", vmid, key)
	}
	entries, _ := os.ReadDir(m.guestFSDir(vmid, key))
	var parts []pveGuestPartition
	var warns []string
	for _, e := range entries {
		n, err := strconv.Atoi(strings.TrimPrefix(e.Name(), "p"))
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "p") || err != nil {
			continue
		}
		parts = append(parts, pveGuestPartition{Disk: key, Index: n, FSType: "ext4", Dir: filepath.Join(m.guestFSDir(vmid, key), e.Name())})
	}
	if len(parts) == 0 {
		warns = append(warns, fmt.Sprintf("%s: no filesystem found", key))
	}
	m.mu.Lock()
	m.attached++
	m.mu.Unlock()
	return parts, warns, func() error {
		m.mu.Lock()
		m.attached--
		m.mu.Unlock()
		return nil
	}, nil
}

func sameFileContent(a, b string) (bool, error) {
	ha, err := fileSHA256(a)
	if err != nil {
		return false, err
	}
	hb, err := fileSHA256(b)
	if err != nil {
		return false, err
	}
	return ha == hb, nil
}

func fileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// mockOverlay is what the mock keeps of a qcow2 overlay.
type mockOverlay struct {
	Backing string `json:"backing"`
	Size    int64  `json:"size"`
}

func (m *mockPve) overlayPath(volid string) string {
	return filepath.Join(m.dir, "overlays", strings.NewReplacer(":", "_", "/", "_").Replace(volid)+".json")
}

func (m *mockPve) CreateOverlay(ctx context.Context, storage string, vmid int, key, image string, size int64) (string, error) {
	st, err := m.Storages(ctx)
	if err != nil {
		return "", err
	}
	if s := st[storage]; s == nil || !overlayCapable(s.Type) {
		return "", fmt.Errorf("mock: storage %s does not support qcow2", storage)
	}
	if _, err := os.Stat(image); err != nil {
		return "", err
	}
	volid := fmt.Sprintf("%s:%d/vm-%d-amberlive-%s.qcow2", storage, vmid, vmid, key)
	data, _ := json.Marshal(mockOverlay{Backing: image, Size: size})
	os.MkdirAll(filepath.Join(m.dir, "overlays"), 0o755)
	return volid, os.WriteFile(m.overlayPath(volid), data, 0o600)
}

func (m *mockPve) FreeVolume(ctx context.Context, volid string) error {
	err := os.Remove(m.overlayPath(volid))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func (m *mockPve) WriteGuestConfig(ctx context.Context, vmid int, text string) error {
	return m.update(func(s *mockPveState) error {
		if g, err := m.guest(s, vmid); err == nil {
			return fmt.Errorf("VM %d already exists on node %s", vmid, g.Node)
		}
		s.Guests = append(s.Guests, &mockPveGuest{VMID: vmid, Type: pveTypeQemu, Node: m.self(), Status: "stopped", Config: text})
		return nil
	})
}

func (m *mockPve) DestroyGuest(ctx context.Context, typ string, vmid int) error {
	var cfg string
	err := m.update(func(s *mockPveState) error {
		var rest []*mockPveGuest
		for _, g := range s.Guests {
			if g.VMID == vmid {
				cfg = g.Config
				continue
			}
			rest = append(rest, g)
		}
		s.Guests = rest
		return nil
	})
	for _, d := range guestDisks(typ, parsePveConfig(cfg)) {
		m.FreeVolume(ctx, d.Volid)
	}
	os.RemoveAll(filepath.Join(m.dir, "disks", strconv.Itoa(vmid)))
	return err
}

// MoveDisk copies the overlay's content (its backing image) into a disk of
// the target storage and points the config at it, like qm disk move.
func (m *mockPve) MoveDisk(ctx context.Context, vmid int, key, storage string, onProgress func(done, total int64)) error {
	s, err := m.read()
	if err != nil {
		return err
	}
	g, err := m.guest(s, vmid)
	if err != nil {
		return err
	}
	vol, _ := propList(parsePveConfig(g.Config).Keys[key])
	data, err := os.ReadFile(m.overlayPath(vol))
	if err != nil {
		return fmt.Errorf("mock: disk %s of VM %d is no overlay: %w", key, vmid, err)
	}
	var ov mockOverlay
	if err := json.Unmarshal(data, &ov); err != nil {
		return err
	}
	in, err := os.Open(ov.Backing)
	if err != nil {
		return err
	}
	defer in.Close()
	dst := m.diskPath(vmid, key)
	os.MkdirAll(filepath.Dir(dst), 0o755)
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	buf := make([]byte, 1<<20)
	var done int64
	for done < ov.Size {
		if ctx.Err() != nil {
			out.Close()
			return ctx.Err()
		}
		n, rerr := in.Read(buf)
		if n > 0 {
			if _, err := out.Write(buf[:n]); err != nil {
				out.Close()
				return err
			}
			done += int64(n)
			onProgress(done, ov.Size)
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			out.Close()
			return rerr
		}
	}
	if err := out.Close(); err != nil {
		return err
	}
	newVol := fmt.Sprintf("%s:vm-%d-disk-%s", storage, vmid, key)
	if err := m.update(func(s *mockPveState) error {
		g, err := m.guest(s, vmid)
		if err != nil {
			return err
		}
		g.Config = strings.Replace(g.Config, key+": "+vol, key+": "+newVol, 1)
		return nil
	}); err != nil {
		return err
	}
	return m.FreeVolume(ctx, vol)
}

// SetGuestFile puts a file into a simulated filesystem of a VM disk.
func (m *mockPve) SetGuestFile(vmid int, key string, part int, rel string, data []byte, mode os.FileMode) error {
	p := filepath.Join(m.guestFSDir(vmid, key), "p"+strconv.Itoa(part), filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, data, mode)
}

// Attached counts images attached and not yet detached.
func (m *mockPve) Attached() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.attached
}
