package main

// Proxmox restores. A whole guest is always restored through PVE's own tools:
// the agent streams a vzdump-format archive into qmrestore / pct restore —
// the stored vzdump archive as is, a VMA synthesized from the block method's
// segments, or a CT tar rewritten from the files method's tree. A file restore
// (files snapshots) puts files straight into a container's root. File
// restores from VM backups and live restores read a block snapshot as disk
// images (proxmox_vmrestore.go).

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"path"
	"sort"
	"strconv"
	"strings"
)

func (a *agent) runProxmoxRestore(ctx context.Context, t *Task) {
	var logBuf strings.Builder
	appendLog := func(s string) { logBuf.WriteString(s + "\n") }
	if a.proxmox == nil || t.Proxmox == nil || t.Proxmox.Restore == nil {
		a.failTask(t, "Proxmox VE is not available on this agent", "")
		return
	}
	stats, err := a.proxmoxRestore(ctx, t, appendLog)
	if ctx.Err() != nil {
		a.cancelTask(t, logBuf.String())
		return
	}
	if err != nil {
		a.failTask(t, err.Error(), logBuf.String())
		return
	}
	a.postResult(t.TaskID, TaskResult{Status: "success", Stats: stats, Log: logBuf.String()})
	log.Printf("proxmox-restore %s complete", t.TaskID)
}

// snapshotMethod tells from a snapshot's paths and manifest how it was made.
func (a *agent) snapshotMethod(ctx context.Context, t *Task) (string, string, *pveManifest, error) {
	info, err := a.snapshotInfo(ctx, t, t.SnapshotID)
	if err != nil {
		return "", "", nil, err
	}
	root := info.Paths[0]
	if strings.HasPrefix(path.Base(root), "vzdump-") {
		return pveMethodVzdump, root, nil, nil
	}
	data, err := a.dumpFile(ctx, t, t.SnapshotID, path.Join(root, pveManifestName))
	if err != nil {
		return "", "", nil, fmt.Errorf("the snapshot has no Amber manifest: %w", err)
	}
	var m pveManifest
	if err := json.Unmarshal(data, &m); err != nil {
		return "", "", nil, fmt.Errorf("reading the manifest: %w", err)
	}
	return m.Method, root, &m, nil
}

func (a *agent) proxmoxRestore(ctx context.Context, t *Task, appendLog func(string)) (map[string]any, error) {
	be := a.proxmox.backend
	spec := t.Proxmox.Restore
	info, err := a.proxmox.agentInfo(ctx)
	if err != nil {
		return nil, err
	}
	method, root, m, err := a.snapshotMethod(ctx, t)
	if err != nil {
		return nil, err
	}
	appendLog(fmt.Sprintf("snapshot %s: %s backup of guest %d", t.SnapshotID, method, spec.VMID))
	switch {
	case spec.Action == "files":
		return a.restoreCTFiles(ctx, t, info, method, root, appendLog)
	case spec.Action == "vm-files":
		return a.restoreVMFiles(ctx, t, info, method, root, m, appendLog)
	case spec.LiveRestore:
		return a.liveRestore(ctx, t, info, method, root, m, appendLog)
	}

	typ := spec.GuestType
	if typ == "" {
		typ = pveTypeQemu
	}
	res := ProxmoxRestoreResult{SourceVMID: spec.VMID, Node: info.Node}
	opts := pveRestoreOpts{Storage: spec.Storage, Unique: spec.Unique, BwlimitKiB: spec.BwlimitKiB}
	target := spec.NewVMID
	if spec.ReplaceOriginal {
		target = spec.VMID
		node, _, lerr := be.LocateGuest(ctx, target)
		switch {
		case lerr == nil && node != info.Node:
			return nil, fmt.Errorf("guest %d is on node %s; restore it there to replace it", target, node)
		case lerr == nil:
			if st, _ := be.GuestStatus(ctx, typ, target); st == "running" {
				appendLog(fmt.Sprintf("stopping guest %d", target))
				if err := be.StopGuest(ctx, typ, target); err != nil {
					return nil, fmt.Errorf("stopping guest %d: %w", target, err)
				}
			}
			opts.Force = true
			res.ReplacedOriginal = true
		case !errors.Is(lerr, errGuestNotFound):
			return nil, lerr
		}
	} else {
		if target == 0 {
			if target, err = be.NextVMID(ctx); err != nil {
				return nil, fmt.Errorf("finding a free VMID: %w", err)
			}
		}
		if _, _, lerr := be.LocateGuest(ctx, target); lerr == nil {
			return nil, fmt.Errorf("VMID %d is already in use", target)
		}
	}
	res.VMID = target
	appendLog(fmt.Sprintf("restoring as %s %d on %s", typ, target, info.Node))

	pr, pw := io.Pipe()
	var dumpLog strings.Builder
	go func() {
		var err error
		switch method {
		case pveMethodVzdump:
			err = a.dumpTo(ctx, t, []string{"dump", "--", t.SnapshotID, root}, pw, &dumpLog)
		case pveMethodBlock:
			err = a.streamBlockVMA(ctx, t, root, m, pw, &dumpLog)
		case pveMethodFiles:
			err = a.streamCTArchive(ctx, t, root, m, pw, &dumpLog)
		default:
			err = fmt.Errorf("unknown backup method %q", method)
		}
		pw.CloseWithError(err)
	}()
	rerr := be.RestoreGuest(ctx, typ, target, opts, pr, appendLog)
	pr.CloseWithError(errors.New("restore ended"))
	if s := strings.TrimSpace(dumpLog.String()); s != "" {
		appendLog(s)
	}
	if rerr != nil {
		return nil, fmt.Errorf("restore failed: %w", rerr)
	}
	if spec.Name != "" {
		if err := be.SetName(ctx, typ, target, spec.Name); err != nil {
			res.Warnings = append(res.Warnings, "setting the name: "+err.Error())
		}
	}
	if spec.Start {
		if err := be.StartGuest(ctx, typ, target); err != nil {
			res.Warnings = append(res.Warnings, "starting the guest: "+err.Error())
		}
	}
	for _, w := range res.Warnings {
		appendLog("warning: " + w)
	}
	return map[string]any{"proxmoxRestore": res, "percentDone": 1}, nil
}

// dumpTo runs a restic dump into w.
func (a *agent) dumpTo(ctx context.Context, t *Task, args []string, w io.Writer, logBuf *strings.Builder) error {
	code, err := a.runner.runToWriter(ctx, t, args, w, func(s string) { logBuf.WriteString(s + "\n") })
	if err != nil || code != 0 {
		return fmt.Errorf("restic dump exited %d: %v %s", code, err, strings.TrimSpace(logBuf.String()))
	}
	return nil
}

// vmaDeviceName is the VMA device of a disk.
// ASSUMPTION(pve): vzdump names devices drive-<key>, the TPM state
// drive-tpmstate0-backup, and qmrestore maps them back through the
// `#qmdump#map:<key>:<device>:<storage>:<format>:` lines of the config.
func vmaDeviceName(key string) string {
	if key == "tpmstate0" {
		return "drive-tpmstate0-backup"
	}
	return "drive-" + key
}

// vmaConfigText is the qemu-server.conf stored in a synthesized VMA.
func vmaConfigText(m *pveManifest) string {
	var b strings.Builder
	for _, d := range m.Disks {
		fmt.Fprintf(&b, "#qmdump#map:%s:%s:%s:%s:\n", d.Key, vmaDeviceName(d.Key), d.Storage, d.Format)
	}
	b.WriteString(m.Config)
	return b.String()
}

// streamBlockVMA writes a VMA of a block snapshot: the manifest's config and
// disk sizes, then each disk's segments in order from `restic dump --archive tar`.
func (a *agent) streamBlockVMA(ctx context.Context, t *Task, root string, m *pveManifest, w io.Writer, logBuf *strings.Builder) error {
	if m == nil || m.SegmentBytes <= 0 {
		return errors.New("the block snapshot's manifest is incomplete")
	}
	disks := append([]ProxmoxGuestDisk(nil), m.Disks...)
	sort.Slice(disks, func(i, j int) bool { return disks[i].Key < disks[j].Key })
	ids := map[string]int{}
	var devs []vmaDevice
	for i, d := range disks {
		size := m.DiskSizes[d.Key]
		if size == 0 {
			size = d.SizeBytes
		}
		devs = append(devs, vmaDevice{Name: vmaDeviceName(d.Key), Size: size})
		ids[d.Key] = i + 1
	}
	vw, err := newVMAWriter(w, []vmaConfig{{Name: "qemu-server.conf", Data: []byte(vmaConfigText(m))}}, devs)
	if err != nil {
		return err
	}
	pr, pw := io.Pipe()
	go func() {
		pw.CloseWithError(a.dumpTo(ctx, t, []string{"dump", "--archive", "tar", "--", t.SnapshotID, root + "/disks"}, pw, logBuf))
	}()
	defer pr.Close()
	prefix := strings.TrimPrefix(root, "/") + "/disks/"
	next := map[string]int64{}
	tr := tar.NewReader(pr)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		rel, ok := strings.CutPrefix(strings.TrimPrefix(h.Name, "/"), prefix)
		if !ok {
			continue
		}
		parts := strings.Split(rel, "/")
		if len(parts) != 3 {
			continue
		}
		key := parts[0]
		id, ok := ids[key]
		if !ok {
			return fmt.Errorf("segment of unknown disk %s", key)
		}
		dir, e1 := strconv.ParseInt(parts[1], 10, 64)
		seg, e2 := strconv.ParseInt(strings.TrimSuffix(parts[2], ".seg"), 10, 64)
		if e1 != nil || e2 != nil {
			continue
		}
		idx := dir*pveSegmentsPerDir + seg
		if idx != next[key] {
			return fmt.Errorf("disk %s: segment %d missing in the snapshot", key, next[key])
		}
		if want := segmentLen(devs[id-1].Size, m.SegmentBytes, idx); h.Size != want {
			return fmt.Errorf("disk %s: segment %d has %d bytes, expected %d", key, idx, h.Size, want)
		}
		if _, err := io.Copy(vw.Device(id), tr); err != nil {
			return err
		}
		next[key]++
	}
	for _, d := range disks {
		want := segmentCount(devs[ids[d.Key]-1].Size, m.SegmentBytes)
		if next[d.Key] != want {
			return fmt.Errorf("disk %s: %d of %d segments in the snapshot", d.Key, next[d.Key], want)
		}
	}
	return vw.Close()
}

// streamCTArchive writes a pct-restorable tar of a files snapshot.
func (a *agent) streamCTArchive(ctx context.Context, t *Task, root string, m *pveManifest, w io.Writer, logBuf *strings.Builder) error {
	if m == nil {
		return errors.New("the snapshot has no manifest")
	}
	conf, err := a.dumpFile(ctx, t, t.SnapshotID, root+"/lxc.conf")
	if err != nil {
		conf = []byte(m.Config)
	}
	pr, pw := io.Pipe()
	go func() {
		pw.CloseWithError(a.dumpTo(ctx, t, []string{"dump", "--archive", "tar", "--", t.SnapshotID, root + "/root"}, pw, logBuf))
	}()
	defer pr.Close()
	return rewriteCTArchive(w, pr, strings.TrimPrefix(root, "/")+"/root", conf, m.IDMap)
}

// restoreCTFiles restores (some) files of a files snapshot into a container.
func (a *agent) restoreCTFiles(ctx context.Context, t *Task, info *ProxmoxAgentInfo, method, root string, appendLog func(string)) (map[string]any, error) {
	spec := t.Proxmox.Restore
	if method != pveMethodFiles {
		return nil, errors.New("only file-level container backups can restore single files")
	}
	be := a.proxmox.backend
	target := spec.TargetVMID
	if target == 0 {
		target = spec.VMID
	}
	node, typ, err := be.LocateGuest(ctx, target)
	if err != nil {
		return nil, fmt.Errorf("container %d: %w", target, err)
	}
	if typ != pveTypeLXC {
		return nil, fmt.Errorf("guest %d is not a container", target)
	}
	if node != info.Node {
		return nil, fmt.Errorf("container %d is on node %s, not %s", target, node, info.Node)
	}
	rootfs, release, err := be.CTRootfs(ctx, target)
	if err != nil {
		return nil, fmt.Errorf("reaching the container's root: %w", err)
	}
	defer release()
	sub := root + "/root"
	var includes []string
	for _, inc := range restoreIncludes(t) {
		if rel, ok := strings.CutPrefix(inc, sub); ok {
			if rel == "" {
				rel = "/"
			}
			includes = append(includes, rel)
		} else {
			includes = append(includes, inc)
		}
	}
	appendLog(fmt.Sprintf("restoring files into container %d (%s)", target, rootfs))
	args := restoreArgsFor(t.SnapshotID+":"+sub, rootfs, includes, t.RestoreOptions)
	stats, err := a.restoreOnce(ctx, t, args, appendLog)
	if err != nil {
		return nil, err
	}
	if stats == nil {
		stats = map[string]any{"percentDone": 1}
	}
	stats["proxmoxRestore"] = ProxmoxRestoreResult{SourceVMID: spec.VMID, VMID: target, Node: info.Node}
	return stats, nil
}
