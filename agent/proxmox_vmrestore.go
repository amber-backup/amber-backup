package main

// Restores that read a VM's block snapshot as disk images instead of
// streaming it into qmrestore:
//
//   vm-files     — file restore from a VM backup: the repository is mounted
//                  (`restic mount`), each disk served as a raw image
//                  (concatImage over the segment files), its filesystems
//                  attached read-only (loop device + mount) and the selected
//                  paths copied to a directory on the node.
//   live restore — the VM starts right away from qcow2 overlays whose backing
//                  files are those images; `qm disk move` then mirrors every
//                  disk into its real storage while the VM runs. Until the
//                  moves finish the VM reads from the backup through this
//                  agent, as with a PBS live restore.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// blockImageSet is a mounted repository plus the image view of one snapshot.
type blockImageSet struct {
	base   string
	images map[string]string // disk key → image path
	sizes  map[string]int64
	undo   []func()
}

func (s *blockImageSet) cleanup() {
	for i := len(s.undo) - 1; i >= 0; i-- {
		s.undo[i]()
	}
	s.undo = nil
	// Only remove the work directory once nothing is mounted below it.
	if len(mountsBelowOrNone(s.base)) == 0 {
		os.RemoveAll(s.base)
	}
}

// mountBlockImages mounts the repository and serves the given disks of the
// block snapshot (root = its path in the snapshot) as raw images.
func (a *agent) mountBlockImages(ctx context.Context, t *Task, root string, m *pveManifest, keys []string, appendLog func(string)) (*blockImageSet, error) {
	if m == nil || m.SegmentBytes <= 0 {
		return nil, errors.New("the block snapshot's manifest is incomplete")
	}
	base := filepath.Join(pveMountBase(), "restore-"+pveShortID(t.TaskID))
	cleanupMountsBelow(base)
	set := &blockImageSet{base: base, images: map[string]string{}, sizes: map[string]int64{}}
	repoDir := filepath.Join(base, "repo")
	stop, err := a.startResticMount(ctx, t, repoDir, appendLog)
	if err != nil {
		set.cleanup()
		return nil, fmt.Errorf("mounting the repository: %w", err)
	}
	set.undo = append(set.undo, stop)
	snapDir, err := snapshotMountDir(repoDir, t.SnapshotID)
	if err != nil {
		set.cleanup()
		return nil, err
	}
	segRoot := filepath.Join(snapDir, filepath.FromSlash(strings.TrimPrefix(root, "/")))
	var imgs []*concatImage
	for _, key := range keys {
		size := m.DiskSizes[key]
		if size == 0 {
			for _, d := range m.Disks {
				if d.Key == key {
					size = d.SizeBytes
				}
			}
		}
		if size <= 0 {
			set.cleanup()
			return nil, fmt.Errorf("disk %s: size unknown", key)
		}
		imgs = append(imgs, newConcatImage(segRoot, key, size, m.SegmentBytes))
		set.sizes[key] = size
	}
	imgDir := filepath.Join(base, "images")
	unmount, err := mountConcatView(imgDir, imgs)
	if err != nil {
		set.cleanup()
		return nil, err
	}
	set.undo = append(set.undo, func() {
		if err := unmount(); err != nil {
			appendLog("unmounting the image view: " + err.Error())
		}
	})
	for _, key := range keys {
		set.images[key] = filepath.Join(imgDir, imageName(key))
	}
	appendLog(fmt.Sprintf("serving %d disk image(s) from snapshot %s", len(keys), t.SnapshotID))
	return set, nil
}

// fsDisks are the manifest's disks that may hold guest filesystems.
func fsDisks(m *pveManifest) []string {
	var keys []string
	for _, d := range m.Disks {
		if d.Key == "efidisk0" || d.Key == "tpmstate0" {
			continue
		}
		keys = append(keys, d.Key)
	}
	sort.Strings(keys)
	return keys
}

func requireBlockVM(method string, m *pveManifest, what string) error {
	if method != pveMethodBlock || m == nil || m.Type != pveTypeQemu {
		return fmt.Errorf("%s needs a block backup of a VM (this snapshot is a %s backup)", what, method)
	}
	return nil
}

// restoreVMFiles copies files out of a VM block snapshot to spec.TargetPath.
func (a *agent) restoreVMFiles(ctx context.Context, t *Task, info *ProxmoxAgentInfo, method, root string, m *pveManifest, appendLog func(string)) (map[string]any, error) {
	spec := t.Proxmox.Restore
	if err := requireBlockVM(method, m, "a file restore from a VM"); err != nil {
		return nil, err
	}
	target := filepath.Clean(spec.TargetPath)
	if spec.TargetPath == "" || !filepath.IsAbs(target) || target == "/" {
		return nil, errors.New("the target directory must be an absolute path other than /")
	}
	sels, err := parseGuestPaths(restoreIncludes(t))
	if err != nil {
		return nil, err
	}
	keys := fsDisks(m)
	if len(keys) == 0 {
		return nil, errors.New("the backup holds no data disks")
	}
	// Selectors that all name a disk limit which disks are attached at all.
	wanted := map[string]bool{}
	for _, s := range sels {
		if s.Disk == "" {
			wanted = nil
			break
		}
		wanted[s.Disk] = true
	}
	if wanted != nil {
		var only []string
		for _, k := range keys {
			if wanted[k] {
				only = append(only, k)
			}
		}
		if len(only) == 0 {
			return nil, fmt.Errorf("the backup has no disk %s", strings.Join(sortedKeys(wanted), ", "))
		}
		keys = only
	}
	if err := os.MkdirAll(target, 0o750); err != nil {
		return nil, fmt.Errorf("creating %s: %w", target, err)
	}

	set, err := a.mountBlockImages(ctx, t, root, m, keys, appendLog)
	if err != nil {
		return nil, err
	}
	defer set.cleanup()
	be := a.proxmox.backend
	res := ProxmoxRestoreResult{SourceVMID: spec.VMID, VMID: spec.VMID, Node: info.Node, TargetPath: target}
	var parts []pveGuestPartition
	for _, key := range keys {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		ps, warns, detach, err := be.AttachImage(ctx, m.VMID, key, set.images[key], filepath.Join(set.base, "parts", key))
		res.Warnings = append(res.Warnings, warns...)
		if err != nil {
			return nil, fmt.Errorf("disk %s: %w", key, err)
		}
		set.undo = append(set.undo, func() {
			if err := detach(); err != nil {
				appendLog(fmt.Sprintf("detaching disk %s: %v", key, err))
			}
		})
		for _, p := range ps {
			appendLog(fmt.Sprintf("disk %s: partition %d (%s) mounted", key, p.Index, p.FSType))
		}
		parts = append(parts, ps...)
	}
	stats, used, err := copyGuestPaths(parts, sels, target, appendLog)
	if err != nil {
		return nil, err
	}
	res.FilesRestored, res.BytesRestored, res.Partitions = stats.Files, stats.Bytes, used
	for _, w := range res.Warnings {
		appendLog("warning: " + w)
	}
	appendLog(fmt.Sprintf("restored %d files (%d bytes) to %s", stats.Files, stats.Bytes, target))
	return map[string]any{
		"proxmoxRestore": res, "percentDone": 1,
		"filesDone": stats.Files, "totalFiles": stats.Files,
		"bytesDone": stats.Bytes, "totalBytes": stats.Bytes,
	}, nil
}

// liveRestore starts the VM from the backup and moves its disks into place.
func (a *agent) liveRestore(ctx context.Context, t *Task, info *ProxmoxAgentInfo, method, root string, m *pveManifest, appendLog func(string)) (map[string]any, error) {
	spec := t.Proxmox.Restore
	be := a.proxmox.backend
	if err := requireBlockVM(method, m, "a live restore"); err != nil {
		return nil, err
	}
	if spec.OverlayStorage == "" {
		return nil, errors.New("a live restore needs an overlay storage")
	}
	if spec.ReplaceOriginal {
		return nil, errors.New("a live restore always creates a new VM; it cannot replace the original")
	}
	storages, err := be.Storages(ctx)
	if err != nil {
		return nil, err
	}
	if st := storages[spec.OverlayStorage]; st == nil || !overlayCapable(st.Type) {
		return nil, fmt.Errorf("storage %s cannot hold qcow2 overlays (a dir, NFS or CIFS storage is needed)", spec.OverlayStorage)
	}
	vmid := spec.NewVMID
	if vmid == 0 {
		if vmid, err = be.NextVMID(ctx); err != nil {
			return nil, fmt.Errorf("finding a free VMID: %w", err)
		}
	}
	if _, _, lerr := be.LocateGuest(ctx, vmid); lerr == nil {
		return nil, fmt.Errorf("VMID %d is already in use", vmid)
	}
	disks := append([]ProxmoxGuestDisk(nil), m.Disks...)
	sort.Slice(disks, func(i, j int) bool { return disks[i].Key < disks[j].Key })
	var keys []string
	for _, d := range disks {
		keys = append(keys, d.Key)
	}
	if len(keys) == 0 {
		return nil, errors.New("the backup holds no disks")
	}

	set, err := a.mountBlockImages(ctx, t, root, m, keys, appendLog)
	if err != nil {
		return nil, err
	}
	res := ProxmoxRestoreResult{SourceVMID: spec.VMID, VMID: vmid, Node: info.Node, LiveRestore: true}
	started := false
	defer func() {
		if !started {
			set.cleanup()
		}
	}()

	// 1. qcow2 overlays on top of the images.
	overlays := map[string]string{}
	freeOverlays := func() {
		c, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		for _, v := range overlays {
			if err := be.FreeVolume(c, v); err != nil {
				appendLog("removing overlay " + v + ": " + err.Error())
			}
		}
	}
	for _, key := range keys {
		volid, err := be.CreateOverlay(ctx, spec.OverlayStorage, vmid, key, set.images[key], set.sizes[key])
		if err != nil {
			freeOverlays()
			return nil, fmt.Errorf("creating the overlay of %s: %w", key, err)
		}
		overlays[key] = volid
		appendLog(fmt.Sprintf("disk %s: overlay %s", key, volid))
	}

	// 2. Register the VM with its disks on the overlays.
	conf, warns := liveRestoreConfig(m.Config, overlays, spec.Name, spec.Unique)
	res.Warnings = append(res.Warnings, warns...)
	if err := be.WriteGuestConfig(ctx, vmid, conf); err != nil {
		freeOverlays()
		return nil, fmt.Errorf("registering VM %d: %w", vmid, err)
	}
	destroy := func() {
		c, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if err := be.DestroyGuest(c, pveTypeQemu, vmid); err != nil {
			appendLog(fmt.Sprintf("removing VM %d: %v", vmid, err))
		}
	}

	// 3. Start it.
	if err := be.StartGuest(ctx, pveTypeQemu, vmid); err != nil {
		destroy()
		return nil, fmt.Errorf("starting VM %d: %w", vmid, err)
	}
	started = true
	defer set.cleanup()
	appendLog(fmt.Sprintf("VM %d is running from the backup; moving its disks into place", vmid))

	// 4. Move every disk off its overlay into the real storage.
	var total, before int64
	for _, k := range keys {
		total += set.sizes[k]
	}
	var lastPost time.Time
	for _, d := range disks {
		target := spec.Storage
		if target == "" {
			target = d.Storage
		}
		err := be.MoveDisk(ctx, vmid, d.Key, target, func(done, size int64) {
			if time.Since(lastPost) < time.Second {
				return
			}
			lastPost = time.Now()
			if size > 0 {
				done = done * set.sizes[d.Key] / size
			}
			a.postProgress(t.TaskID, map[string]any{
				"percentDone": float64(before+done) / float64(total),
				"bytesDone":   before + done, "totalBytes": total,
			})
		})
		if err != nil {
			// The rest of the VM still reads from the backup, which goes away
			// with this task: stop the VM rather than let its disks fail.
			c, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			serr := be.StopGuest(c, pveTypeQemu, vmid)
			cancel()
			stopped := "it was stopped"
			if serr != nil {
				stopped = "stopping it failed too (" + serr.Error() + ")"
			}
			if ctx.Err() != nil {
				appendLog(fmt.Sprintf("live restore of VM %d cancelled while moving %s; %s", vmid, d.Key, stopped))
				return nil, ctx.Err()
			}
			return nil, fmt.Errorf("live restore of VM %d: moving disk %s to %s failed: %v. "+
				"The VM's remaining disks depend on the backup, so %s; its config and overlays are kept "+
				"for inspection — restore the VM again without live restore", vmid, d.Key, target, err, stopped)
		}
		before += set.sizes[d.Key]
		appendLog(fmt.Sprintf("disk %s moved to %s", d.Key, target))
	}
	for _, w := range res.Warnings {
		appendLog("warning: " + w)
	}
	return map[string]any{"proxmoxRestore": res, "percentDone": 1, "bytesDone": total, "totalBytes": total}, nil
}

// overlayCapable: storages whose volumes are files that can be qcow2.
func overlayCapable(storageType string) bool {
	switch storageType {
	case "dir", "nfs", "cifs", "glusterfs":
		return true
	}
	return false
}

var (
	netMacRE = regexp.MustCompile(`^([a-z0-9]+)=([0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5})$`)
	unusedRE = regexp.MustCompile(`^unused\d+$`)
)

// liveRestoreConfig is the backed-up VM config with its disks on the overlays.
// Disks the backup doesn't hold (backup=0, passthrough) are dropped — the new
// VM must never point at the original's volumes. unique gives new MAC
// addresses and a new vmgenid.
func liveRestoreConfig(conf string, overlays map[string]string, name string, unique bool) (string, []string) {
	var out, warns []string
	for _, line := range strings.Split(strings.TrimRight(conf, "\n"), "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok || strings.HasPrefix(strings.TrimSpace(line), "#") {
			out = append(out, line)
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		switch {
		case qemuDiskKeyRE.MatchString(k):
			vol, opts := propList(v)
			if opts["media"] == "cdrom" || vol == "none" {
				out = append(out, line)
				continue
			}
			ov, ok := overlays[k]
			if !ok {
				warns = append(warns, fmt.Sprintf("disk %s (%s) is not in the backup and was left out", k, vol))
				continue
			}
			var keep []string
			for i, p := range strings.Split(v, ",") {
				if i == 0 || strings.HasPrefix(p, "format=") {
					continue
				}
				keep = append(keep, p)
			}
			out = append(out, k+": "+strings.Join(append([]string{ov}, keep...), ","))
		case unusedRE.MatchString(k):
			continue
		case k == "name" && name != "":
			out = append(out, "name: "+name)
			name = ""
		case unique && strings.HasPrefix(k, "net"):
			parts := strings.Split(v, ",")
			for i, p := range parts {
				if mm := netMacRE.FindStringSubmatch(p); mm != nil && (i == 0 || mm[1] == "macaddr") {
					parts[i] = mm[1] + "=" + randomMAC()
				}
			}
			out = append(out, k+": "+strings.Join(parts, ","))
		case unique && k == "vmgenid":
			out = append(out, "vmgenid: "+randomUUID())
		default:
			out = append(out, line)
		}
	}
	if name != "" {
		out = append([]string{"name: " + name}, out...)
	}
	return strings.Join(out, "\n") + "\n", warns
}

// randomMAC is in Proxmox's BC:24:11 range, like the addresses PVE assigns.
func randomMAC() string {
	b := make([]byte, 3)
	rand.Read(b)
	return strings.ToUpper(fmt.Sprintf("BC:24:11:%02x:%02x:%02x", b[0], b[1], b[2]))
}

func randomUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// parseTransferred reads `qm disk move` progress ("transferred 1.5 GiB of 32.0 GiB").
var transferredRE = regexp.MustCompile(`transferred:?\s+([0-9.]+)\s*([KMGTP]?i?B)\s+of\s+([0-9.]+)\s*([KMGTP]?i?B)`)

func parseTransferred(line string) (int64, int64, bool) {
	mm := transferredRE.FindStringSubmatch(line)
	if mm == nil {
		return 0, 0, false
	}
	return unitBytes(mm[1], mm[2]), unitBytes(mm[3], mm[4]), true
}

func unitBytes(num, unit string) int64 {
	f, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0
	}
	mult := map[string]float64{"B": 1, "KiB": 1 << 10, "MiB": 1 << 20, "GiB": 1 << 30, "TiB": 1 << 40, "PiB": 1 << 50,
		"KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12, "PB": 1e15}[unit]
	if mult == 0 {
		mult = 1
	}
	return int64(f * mult)
}
