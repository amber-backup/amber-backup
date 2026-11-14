//go:build linux

package main

// The real Proxmox VE backend: shells out to pvesh, qm, pct, vzdump,
// qmrestore, zfs, lvchange, rbd and qemu-nbd, and reads the cluster
// filesystem (/etc/pve) directly. Nothing here has run against a real PVE
// host yet — every behaviour Amber relies on is marked ASSUMPTION(pve).

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const pveEtc = "/etc/pve"

type realPve struct{}

// newRealPveBackend returns the backend on a PVE node, nil elsewhere.
// ASSUMPTION(pve): a node has /etc/pve (pmxcfs) and the pveversion binary.
func newRealPveBackend() pveBackend {
	if fi, err := os.Stat(pveEtc); err != nil || !fi.IsDir() {
		return nil
	}
	if _, err := exec.LookPath("pveversion"); err != nil {
		return nil
	}
	return &realPve{}
}

func (p *realPve) Name() string { return "pve" }

// run executes a command and returns its trimmed stdout; stderr goes into the error.
func pveRun(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = strings.TrimSpace(out.String())
		}
		return "", fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, msg)
	}
	return strings.TrimSpace(out.String()), nil
}

func pveNodeName() string {
	// ASSUMPTION(pve): the PVE node name is the short hostname.
	h, _ := os.Hostname()
	return strings.SplitN(h, ".", 2)[0]
}

func (p *realPve) Info(ctx context.Context) (*ProxmoxAgentInfo, error) {
	ca, err := os.ReadFile(filepath.Join(pveEtc, "pve-root-ca.pem"))
	if err != nil {
		return nil, fmt.Errorf("reading the cluster CA: %w", err)
	}
	sum := sha256.Sum256(ca)
	ver, err := pveRun(ctx, "pveversion")
	if err != nil {
		return nil, err
	}
	info := &ProxmoxAgentInfo{ClusterID: hex.EncodeToString(sum[:]), Node: pveNodeName(), PveVersion: ver}
	if data, err := os.ReadFile(filepath.Join(pveEtc, "corosync.conf")); err == nil {
		if n := corosyncClusterName(string(data)); n != "" {
			info.ClusterName = &n
		}
	}
	return info, nil
}

// pveResource is an entry of `pvesh get /cluster/resources`.
// ASSUMPTION(pve): field names and types as in the PVE API (template and
// shared as 0/1 numbers, tags separated by ';').
type pveResource struct {
	ID       string  `json:"id"`
	Type     string  `json:"type"`
	Node     string  `json:"node"`
	VMID     int     `json:"vmid"`
	Name     string  `json:"name"`
	Status   string  `json:"status"`
	Template int     `json:"template"`
	Pool     string  `json:"pool"`
	Tags     string  `json:"tags"`
	HaState  string  `json:"hastate"`
	Lock     string  `json:"lock"`
	Storage  string  `json:"storage"`
	Disk     float64 `json:"disk"`
	MaxDisk  float64 `json:"maxdisk"`
	MaxMem   float64 `json:"maxmem"`
	MaxCPU   float64 `json:"maxcpu"`
}

func (p *realPve) resources(ctx context.Context) ([]pveResource, error) {
	out, err := pveRun(ctx, "pvesh", "get", "/cluster/resources", "--output-format", "json")
	if err != nil {
		return nil, err
	}
	var rs []pveResource
	if err := json.Unmarshal([]byte(out), &rs); err != nil {
		return nil, fmt.Errorf("parsing /cluster/resources: %w", err)
	}
	return rs, nil
}

func (p *realPve) Storages(ctx context.Context) (map[string]*pveStorageCfg, error) {
	data, err := os.ReadFile(filepath.Join(pveEtc, "storage.cfg"))
	if err != nil {
		return nil, err
	}
	return parseStorageCfg(string(data)), nil
}

// configPath of a guest on a node (pmxcfs shows every node's configs).
func configPath(node, typ string, vmid int) string {
	dir := "qemu-server"
	if typ == pveTypeLXC {
		dir = "lxc"
	}
	return filepath.Join(pveEtc, "nodes", node, dir, strconv.Itoa(vmid)+".conf")
}

func (p *realPve) Inventory(ctx context.Context) (*ProxmoxInventory, error) {
	info, err := p.Info(ctx)
	if err != nil {
		return nil, err
	}
	rs, err := p.resources(ctx)
	if err != nil {
		return nil, err
	}
	storages, err := p.Storages(ctx)
	if err != nil {
		return nil, err
	}
	inv := &ProxmoxInventory{ClusterName: info.ClusterName, PveVersion: info.PveVersion, ReadBy: info.Node,
		Nodes: []ProxmoxNodeInfo{}, Storages: []ProxmoxStorage{}, Guests: []ProxmoxGuest{}}
	stView := map[string]*ProxmoxStorage{}
	for _, id := range sortedKeys(storages) {
		v := storageView(storages[id])
		inv.Storages = append(inv.Storages, v)
		stView[id] = &inv.Storages[len(inv.Storages)-1]
	}
	for _, r := range rs {
		switch r.Type {
		case "node":
			inv.Nodes = append(inv.Nodes, ProxmoxNodeInfo{Name: r.Node, Online: r.Status == "online"})
		case "storage":
			if r.Node == info.Node {
				if v := stView[r.Storage]; v != nil {
					v.TotalBytes, v.AvailBytes = int64(r.MaxDisk), int64(r.MaxDisk-r.Disk)
				}
			}
		case pveTypeQemu, pveTypeLXC:
			data, err := os.ReadFile(configPath(r.Node, r.Type, r.VMID))
			if err != nil {
				continue // the guest went away while we listed
			}
			g := ProxmoxGuest{VMID: r.VMID, Type: r.Type, Name: r.Name, Node: r.Node, Status: r.Status,
				Template: r.Template == 1, Lock: r.Lock, HaState: r.HaState, Pool: r.Pool, Tags: splitList(r.Tags)}
			inv.Guests = append(inv.Guests, buildGuest(g, parsePveConfig(string(data)), storages))
		}
	}
	return inv, nil
}

func (p *realPve) LocateGuest(ctx context.Context, vmid int) (string, string, error) {
	// ASSUMPTION(pve): /etc/pve/nodes/<node>/{qemu-server,lxc}/<vmid>.conf
	// exists exactly on the node that owns the guest.
	for _, typ := range []string{pveTypeQemu, pveTypeLXC} {
		dir := "qemu-server"
		if typ == pveTypeLXC {
			dir = "lxc"
		}
		matches, _ := filepath.Glob(filepath.Join(pveEtc, "nodes", "*", dir, strconv.Itoa(vmid)+".conf"))
		if len(matches) > 0 {
			return filepath.Base(filepath.Dir(filepath.Dir(matches[0]))), typ, nil
		}
	}
	return "", "", errGuestNotFound
}

// ASSUMPTION(pve): /etc/pve/local links to this node's directory.
func (p *realPve) GuestConfig(ctx context.Context, typ string, vmid int) (*pveConfig, error) {
	data, err := os.ReadFile(configPath("local", typ, vmid))
	if err != nil {
		return nil, err
	}
	return parsePveConfig(string(data)), nil
}

func guestTool(typ string) string {
	if typ == pveTypeLXC {
		return "pct"
	}
	return "qm"
}

func (p *realPve) GuestStatus(ctx context.Context, typ string, vmid int) (string, error) {
	out, err := pveRun(ctx, guestTool(typ), "status", strconv.Itoa(vmid))
	if err != nil {
		return "", err
	}
	// "status: running"
	_, v, _ := strings.Cut(out, ":")
	return strings.TrimSpace(v), nil
}

func (p *realPve) Snapshot(ctx context.Context, typ string, vmid int, name string) error {
	args := []string{"snapshot", strconv.Itoa(vmid), name, "--description", "Amber backup (removed automatically)"}
	if typ == pveTypeQemu {
		args = append(args, "--vmstate", "0")
	}
	_, err := pveRun(ctx, guestTool(typ), args...)
	return err
}

func (p *realPve) DeleteSnapshot(ctx context.Context, typ string, vmid int, name string) error {
	_, err := pveRun(ctx, guestTool(typ), "delsnapshot", strconv.Itoa(vmid), name)
	if err != nil {
		// ASSUMPTION(pve): --force removes the config entry even when the
		// storage snapshot is already gone.
		_, err = pveRun(ctx, guestTool(typ), "delsnapshot", strconv.Itoa(vmid), name, "--force")
	}
	return err
}

func (p *realPve) SetLock(ctx context.Context, typ string, vmid int, lock string) error {
	if lock == "" {
		_, err := pveRun(ctx, guestTool(typ), "unlock", strconv.Itoa(vmid))
		return err
	}
	_, err := pveRun(ctx, guestTool(typ), "set", strconv.Itoa(vmid), "--lock", lock)
	return err
}

func (p *realPve) VzdumpCommand(ctx context.Context, typ string, vmid int, mode string) ([]string, error) {
	// ASSUMPTION(pve): `vzdump --stdout` writes an uncompressed VMA (VMs) or tar
	// (CTs) to stdout, and exits non-zero when the backup fails.
	return []string{"vzdump", strconv.Itoa(vmid), "--stdout", "1", "--compress", "0", "--mode", mode}, nil
}

// --- Snapshot volumes ------------------------------------------------------------

type fileDisk struct {
	f       *os.File
	size    int64
	cleanup func()
}

func (d *fileDisk) ReadAt(p []byte, off int64) (int, error) { return d.f.ReadAt(p, off) }
func (d *fileDisk) Size() int64                             { return d.size }
func (d *fileDisk) Close() error {
	err := d.f.Close()
	if d.cleanup != nil {
		d.cleanup()
	}
	return err
}

func openDevice(path string, cleanup func()) (pveDiskReader, error) {
	// udev may need a moment to create the device node.
	var f *os.File
	var err error
	for i := 0; i < 50; i++ {
		if f, err = os.Open(path); err == nil {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if err != nil {
		if cleanup != nil {
			cleanup()
		}
		return nil, err
	}
	size, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		f.Close()
		if cleanup != nil {
			cleanup()
		}
		return nil, err
	}
	return &fileDisk{f: f, size: size, cleanup: cleanup}, nil
}

func volName(volid string) string {
	_, v, _ := strings.Cut(volid, ":")
	return v
}

func bg() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 2*time.Minute)
}

func (p *realPve) OpenSnapshotDisk(ctx context.Context, vmid int, d ProxmoxGuestDisk, st *pveStorageCfg, snap string) (pveDiskReader, error) {
	if st == nil {
		return nil, fmt.Errorf("unknown storage %s", d.Storage)
	}
	vol := volName(d.Volid)
	switch st.Type {
	case "zfspool":
		// ASSUMPTION(pve): PVE names ZFS snapshots <pool>/<vol>@<snapname>; a
		// zvol snapshot gets a device node once snapdev=visible.
		ds := st.prop("pool") + "/" + vol
		prev, _ := pveRun(ctx, "zfs", "get", "-H", "-o", "value,source", "snapdev", ds)
		if _, err := pveRun(ctx, "zfs", "set", "snapdev=visible", ds); err != nil {
			return nil, err
		}
		restore := func() {
			c, cancel := bg()
			defer cancel()
			f := strings.Fields(prev)
			if len(f) == 2 && f[1] == "local" {
				pveRun(c, "zfs", "set", "snapdev="+f[0], ds)
			} else {
				pveRun(c, "zfs", "inherit", "snapdev", ds)
			}
		}
		return openDevice("/dev/zvol/"+ds+"@"+snap, restore)
	case "lvmthin":
		// ASSUMPTION(pve): an LVM-thin snapshot is the LV snap_<vol>_<snapname>,
		// activated with -K (it has the activation-skip flag).
		vg := st.prop("vgname")
		lv := vg + "/snap_" + vol + "_" + snap
		if _, err := pveRun(ctx, "lvchange", "-ay", "-K", lv); err != nil {
			return nil, err
		}
		return openDevice("/dev/"+lv, func() {
			c, cancel := bg()
			defer cancel()
			pveRun(c, "lvchange", "-an", lv)
		})
	case "rbd":
		dev, err := rbdMap(ctx, st, vol, snap)
		if err != nil {
			return nil, err
		}
		return openDevice(dev, func() {
			c, cancel := bg()
			defer cancel()
			pveRun(c, "rbd", "unmap", dev)
		})
	case "dir", "nfs", "cifs", "glusterfs":
		return qcow2Snapshot(ctx, d.Volid, snap)
	}
	return nil, fmt.Errorf("storage type %s has no readable snapshots", st.Type)
}

// rbdMap maps an RBD snapshot read-only and returns its device.
// ASSUMPTION(pve): a hyperconverged pool uses the host's /etc/ceph config; an
// external one (monhost set) uses /etc/pve/priv/ceph/<storage>.keyring.
func rbdMap(ctx context.Context, st *pveStorageCfg, vol, snap string) (string, error) {
	pool := st.prop("pool")
	if pool == "" {
		pool = "rbd"
	}
	image := pool + "/"
	if ns := st.prop("namespace"); ns != "" {
		image += ns + "/"
	}
	image += vol + "@" + snap
	args := []string{"map", "--read-only", image}
	if user := st.prop("username"); user != "" {
		args = append(args, "--id", user)
	}
	if mon := st.prop("monhost"); mon != "" {
		args = append(args, "-m", strings.ReplaceAll(mon, " ", ","),
			"--keyring", filepath.Join(pveEtc, "priv", "ceph", st.ID+".keyring"))
	}
	return pveRun(ctx, "rbd", args...)
}

// qcow2Snapshot serves an internal qcow2 snapshot with qemu-nbd on a unix
// socket and reads it through the NBD client.
// ASSUMPTION(pve): `qemu-nbd --read-only --force-share -l <snap>` can read an
// internal snapshot of an image QEMU has open (PVE snapshots qcow2 images
// internally); consistency relies on qcow2 never touching snapshot clusters.
func qcow2Snapshot(ctx context.Context, volid, snap string) (pveDiskReader, error) {
	path, err := pveRun(ctx, "pvesm", "path", volid)
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "amber-nbd-")
	if err != nil {
		return nil, err
	}
	sock := filepath.Join(dir, "nbd.sock")
	cmd := exec.Command("qemu-nbd", "--read-only", "--force-share", "--format", "qcow2",
		"--load-snapshot", "snapshot.name="+snap, "--socket", sock, "--persistent", path)
	if err := cmd.Start(); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	stop := func() {
		cmd.Process.Kill()
		cmd.Wait()
		os.RemoveAll(dir)
	}
	var c *nbdClient
	for i := 0; i < 50; i++ {
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		c, err = nbdConnect(cctx, sock, "", "")
		cancel()
		if err == nil {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if err != nil {
		stop()
		return nil, fmt.Errorf("qemu-nbd: %w", err)
	}
	return &nbdDisk{c: c, stop: stop}, nil
}

type nbdDisk struct {
	c    *nbdClient
	stop func()
}

func (d *nbdDisk) ReadAt(p []byte, off int64) (int, error) { return d.c.ReadAt(p, off) }
func (d *nbdDisk) Size() int64                             { return d.c.Size() }
func (d *nbdDisk) Close() error {
	d.c.Close()
	d.stop()
	return nil
}

func (p *realPve) MountSnapshotVolume(ctx context.Context, vmid int, d ProxmoxGuestDisk, st *pveStorageCfg, snap, target string) (func() error, error) {
	if st == nil {
		return nil, fmt.Errorf("unknown storage %s", d.Storage)
	}
	vol := volName(d.Volid)
	umount := func() error {
		c, cancel := bg()
		defer cancel()
		_, err := pveRun(c, "umount", target)
		if err != nil {
			unmountDetach(target)
		}
		return err
	}
	mountDev := func(dev string, after func()) (func() error, error) {
		// ASSUMPTION(pve): CT volumes are ext4 (noload skips the journal replay a
		// read-only snapshot can't take); other filesystems mount plain ro.
		if _, err := pveRun(ctx, "mount", "-o", "ro,noload", dev, target); err != nil {
			if _, err2 := pveRun(ctx, "mount", "-o", "ro", dev, target); err2 != nil {
				after()
				return nil, err
			}
		}
		return func() error { err := umount(); after(); return err }, nil
	}
	switch st.Type {
	case "zfspool":
		// ASSUMPTION(pve): a CT subvol is a dataset <pool>/<vol>; its snapshot is
		// reachable at <mountpoint>/.zfs/snapshot/<snap> even with snapdir=hidden.
		ds := st.prop("pool") + "/" + vol
		mp, err := pveRun(ctx, "zfs", "get", "-H", "-o", "value", "mountpoint", ds)
		if err != nil {
			return nil, err
		}
		src := filepath.Join(mp, ".zfs", "snapshot", snap)
		if _, err := pveRun(ctx, "mount", "--bind", src, target); err != nil {
			return nil, err
		}
		if _, err := pveRun(ctx, "mount", "-o", "remount,bind,ro", target); err != nil {
			umount()
			return nil, err
		}
		return umount, nil
	case "lvmthin":
		lv := st.prop("vgname") + "/snap_" + vol + "_" + snap
		if _, err := pveRun(ctx, "lvchange", "-ay", "-K", lv); err != nil {
			return nil, err
		}
		return mountDev("/dev/"+lv, func() {
			c, cancel := bg()
			defer cancel()
			pveRun(c, "lvchange", "-an", lv)
		})
	case "rbd":
		dev, err := rbdMap(ctx, st, vol, snap)
		if err != nil {
			return nil, err
		}
		return mountDev(dev, func() {
			c, cancel := bg()
			defer cancel()
			pveRun(c, "rbd", "unmap", dev)
		})
	}
	return nil, fmt.Errorf("storage type %s can't be mounted from a snapshot", st.Type)
}

// --- Change tracking (QMP + NBD) -------------------------------------------------

func qmpSocket(vmid int) string { return fmt.Sprintf("/var/run/qemu-server/%d.qmp", vmid) }

func (p *realPve) withQMP(ctx context.Context, vmid int, fn func(*qmpClient, []qmpBlockInfo) error) error {
	cctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	c, err := qmpDial(cctx, qmpSocket(vmid))
	if err != nil {
		return err
	}
	defer c.Close()
	var blocks []qmpBlockInfo
	if err := c.Execute("query-block", nil, &blocks); err != nil {
		return err
	}
	return fn(c, blocks)
}

func (p *realPve) AddBitmaps(ctx context.Context, vmid int, keys []string, name string) error {
	return p.withQMP(ctx, vmid, func(c *qmpClient, blocks []qmpBlockInfo) error {
		var actions []map[string]any
		for _, k := range keys {
			node, _, err := qmpNodeFor(blocks, k)
			if err != nil {
				return err
			}
			actions = append(actions, map[string]any{
				"type": "block-dirty-bitmap-add",
				"data": map[string]any{"node": node, "name": name, "persistent": false},
			})
		}
		// ASSUMPTION(pve): PVE's QEMU accepts non-persistent bitmaps on every
		// disk node in one transaction, next to PVE's own PBS bitmap.
		return c.Execute("transaction", map[string]any{"actions": actions}, nil)
	})
}

func (p *realPve) RemoveBitmaps(ctx context.Context, vmid int, keys []string, name string) error {
	return p.withQMP(ctx, vmid, func(c *qmpClient, blocks []qmpBlockInfo) error {
		var first error
		for _, k := range keys {
			node, b, err := qmpNodeFor(blocks, k)
			if err != nil || !b.hasBitmap(name) {
				continue
			}
			if err := c.Execute("block-dirty-bitmap-remove", map[string]any{"node": node, "name": name}, nil); err != nil && first == nil {
				first = err
			}
		}
		return first
	})
}

func (p *realPve) DirtyExtents(ctx context.Context, vmid int, key, bitmap string) ([]pveExtent, error) {
	var out []pveExtent
	err := p.withQMP(ctx, vmid, func(c *qmpClient, blocks []qmpBlockInfo) error {
		node, b, err := qmpNodeFor(blocks, key)
		if err != nil {
			return err
		}
		if !b.hasBitmap(bitmap) {
			return errNoBitmap
		}
		dir, err := os.MkdirTemp("", "amber-nbd-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
		sock := filepath.Join(dir, "export.sock")
		exportID := "amber-cbt-" + strconv.Itoa(vmid)
		// ASSUMPTION(pve): no other NBD server (e.g. a migration with local
		// disks) runs in this QEMU while the backup reads the bitmap.
		if err := c.Execute("nbd-server-start", map[string]any{
			"addr": map[string]any{"type": "unix", "path": sock},
		}, nil); err != nil {
			return fmt.Errorf("starting QEMU's NBD server: %w", err)
		}
		defer c.Execute("nbd-server-stop", nil, nil)
		if err := c.Execute("block-export-add", map[string]any{
			"type": "nbd", "id": exportID, "node-name": node, "name": exportID,
			"writable": false, "bitmaps": []string{bitmap},
		}, nil); err != nil {
			return fmt.Errorf("exporting the disk's bitmap: %w", err)
		}
		defer c.Execute("block-export-del", map[string]any{"id": exportID, "mode": "hard"}, nil)
		nctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()
		nc, err := nbdConnect(nctx, sock, exportID, "qemu:dirty-bitmap:"+bitmap)
		if err != nil {
			return err
		}
		defer nc.Close()
		out, err = nc.DirtyExtents()
		return err
	})
	return out, err
}

// --- Restore ------------------------------------------------------------------------

func (p *realPve) NextVMID(ctx context.Context) (int, error) {
	out, err := pveRun(ctx, "pvesh", "get", "/cluster/nextid")
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.Trim(out, "\" \n"))
}

func (p *realPve) StopGuest(ctx context.Context, typ string, vmid int) error {
	_, err := pveRun(ctx, guestTool(typ), "stop", strconv.Itoa(vmid))
	return err
}

func (p *realPve) StartGuest(ctx context.Context, typ string, vmid int) error {
	_, err := pveRun(ctx, guestTool(typ), "start", strconv.Itoa(vmid))
	return err
}

func (p *realPve) SetName(ctx context.Context, typ string, vmid int, name string) error {
	key := "--name"
	if typ == pveTypeLXC {
		key = "--hostname"
	}
	_, err := pveRun(ctx, guestTool(typ), "set", strconv.Itoa(vmid), key, name)
	return err
}

// restoreArgv builds the qmrestore / pct restore command reading stdin.
// ASSUMPTION(pve): `qmrestore - <vmid>` and `pct restore <vmid> -` read an
// uncompressed vzdump archive from stdin.
func restoreArgv(typ string, vmid int, o pveRestoreOpts) []string {
	var argv []string
	if typ == pveTypeLXC {
		// ASSUMPTION(pve): pct restore takes `unprivileged` from the archive's
		// pct.conf, so no --unprivileged flag is passed.
		argv = []string{"pct", "restore", strconv.Itoa(vmid), "-"}
	} else {
		argv = []string{"qmrestore", "-", strconv.Itoa(vmid)}
	}
	if o.Storage != "" {
		argv = append(argv, "--storage", o.Storage)
	}
	if o.Unique {
		argv = append(argv, "--unique", "1")
	}
	if o.Force {
		argv = append(argv, "--force", "1")
	}
	if o.BwlimitKiB > 0 {
		argv = append(argv, "--bwlimit", strconv.Itoa(o.BwlimitKiB))
	}
	return argv
}

func (p *realPve) RestoreGuest(ctx context.Context, typ string, vmid int, opts pveRestoreOpts, archive io.Reader, onLog func(string)) error {
	argv := restoreArgv(typ, vmid, opts)
	onLog("running " + strings.Join(argv, " "))
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Stdin = archive
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	if s := strings.TrimSpace(out.String()); s != "" {
		onLog(s)
	}
	return err
}

func (p *realPve) CTRootfs(ctx context.Context, vmid int) (string, func() error, error) {
	st, err := p.GuestStatus(ctx, pveTypeLXC, vmid)
	if err != nil {
		return "", nil, err
	}
	id := strconv.Itoa(vmid)
	if st == "running" {
		// ASSUMPTION(pve): the container's root is reachable through
		// /proc/<init pid>/root (lxc-info -p -H prints the pid).
		pid, err := pveRun(ctx, "lxc-info", "-n", id, "-p", "-H")
		if err != nil {
			return "", nil, err
		}
		return "/proc/" + strings.TrimSpace(pid) + "/root", func() error { return nil }, nil
	}
	// ASSUMPTION(pve): `pct mount` mounts a stopped CT at /var/lib/lxc/<vmid>/rootfs.
	if _, err := pveRun(ctx, "pct", "mount", id); err != nil {
		return "", nil, err
	}
	return "/var/lib/lxc/" + id + "/rootfs", func() error {
		c, cancel := bg()
		defer cancel()
		_, err := pveRun(c, "pct", "unmount", id)
		return err
	}, nil
}
