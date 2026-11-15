//go:build linux

package main

// Point-in-time reads of a running VM's disks on storage without snapshots
// (raw images on a directory, thick LVM, iSCSI, …): QEMU "image fleecing"
// (docs/interop/live-block-operations). Per disk a temporary qcow2, backed by
// the live disk, receives every block the guest overwrites before it is
// overwritten (blockdev-backup sync=none, i.e. copy-before-write); an NBD
// export of that qcow2 shows the disk as it was when the jobs started. The
// guest keeps running; the temporary images only grow by what it writes
// meanwhile.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// fleecePrefix names every job, block node and NBD export of a fleecing view.
const fleecePrefix = "amber-fl-"

// fleeceDir holds the temporary images. It needs room for what the guests
// write during their backups (Amber requires their full size to be free).
func fleeceDir() string { return getenv("AMBER_PVE_FLEECE_DIR", "/var/tmp/amber-fleece") }

func fleeceFile(vmid int, key string) string {
	return filepath.Join(fleeceDir(), fmt.Sprintf("%d-%s.qcow2", vmid, key))
}

func (p *realPve) fleece(vmid int) *fleeceState {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.fleeces[vmid]
}

func (p *realPve) setFleece(vmid int, st *fleeceState) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.fleeces == nil {
		p.fleeces = map[int]*fleeceState{}
	}
	if st == nil {
		delete(p.fleeces, vmid)
	} else {
		p.fleeces[vmid] = st
	}
}

// nodeHasBitmap looks a bitmap up on a named block node (query-block only
// shows a device's top node, which is a filter while a fleecing view runs).
func nodeHasBitmap(c *qmpClient, node, bitmap string) (bool, error) {
	var nodes []struct {
		NodeName     string `json:"node-name"`
		DirtyBitmaps []struct {
			Name string `json:"name"`
		} `json:"dirty-bitmaps"`
	}
	if err := c.Execute("query-named-block-nodes", map[string]any{"flat": true}, &nodes); err != nil {
		return false, err
	}
	for _, n := range nodes {
		if n.NodeName != node {
			continue
		}
		for _, b := range n.DirtyBitmaps {
			if b.Name == bitmap {
				return true, nil
			}
		}
		return false, nil
	}
	return false, fmt.Errorf("block node %s not found", node)
}

func freeBytes(dir string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

// fleeceNeed is the room the temporary images may take in the worst case
// (the guest overwrites every block): the disks plus qcow2 metadata.
func fleeceNeed(sizes []int64) int64 {
	var n int64
	for _, s := range sizes {
		n += s
	}
	return n + n/100 + 64<<20
}

func (p *realPve) FleeceDisks(ctx context.Context, vmid int, keys []string, freeze bool, logf func(string, ...any)) (map[string]pveDiskReader, func(), bool, error) {
	type fleeceDisk struct {
		key, src, node, file string
		size                 int64
	}
	var disks []fleeceDisk
	err := p.withQMP(ctx, vmid, func(c *qmpClient, blocks []qmpBlockInfo) error {
		for _, k := range keys {
			src, b, err := qmpNodeFor(blocks, k)
			if err != nil {
				return err
			}
			if b.Inserted.Image == nil || b.Inserted.Image.VirtualSize <= 0 {
				return fmt.Errorf("QEMU reports no size for %s", k)
			}
			disks = append(disks, fleeceDisk{key: k, src: src, node: fleecePrefix + k,
				file: fleeceFile(vmid, k), size: b.Inserted.Image.VirtualSize})
		}
		return nil
	})
	if err != nil {
		return nil, nil, false, err
	}
	if err := os.MkdirAll(fleeceDir(), 0o700); err != nil {
		return nil, nil, false, err
	}
	var sizes []int64
	for _, d := range disks {
		sizes = append(sizes, d.size)
	}
	need := fleeceNeed(sizes)
	if free, err := freeBytes(fleeceDir()); err != nil {
		return nil, nil, false, err
	} else if free < need {
		return nil, nil, false, fmt.Errorf("%s has %s free, the fleecing images may need %s (set AMBER_PVE_FLEECE_DIR to a larger filesystem)",
			fleeceDir(), fmtBytesIEC(free), fmtBytesIEC(need))
	}

	readers := map[string]pveDiskReader{}
	sockDir := ""
	cleanup := func() {
		for k, r := range readers {
			r.Close()
			delete(readers, k)
		}
		c, cancel := bg()
		defer cancel()
		if err := p.CleanupFleecing(c, vmid); err != nil {
			logf("removing the fleecing view: %v", err)
		}
		if sockDir != "" {
			os.RemoveAll(sockDir)
		}
	}
	fail := func(err error) (map[string]pveDiskReader, func(), bool, error) {
		cleanup()
		return nil, nil, false, err
	}

	for _, d := range disks {
		os.Remove(d.file)
		if _, err := pveRun(ctx, "qemu-img", "create", "-q", "-f", "qcow2", d.file, strconv.FormatInt(d.size, 10)); err != nil {
			return fail(err)
		}
	}
	// The qcow2 reads through to the live disk wherever the guest has not
	// written since; blockdev-backup copies old data into it before a write.
	err = p.withQMP(ctx, vmid, func(c *qmpClient, _ []qmpBlockInfo) error {
		for _, d := range disks {
			if err := c.Execute("blockdev-add", map[string]any{
				"driver": "qcow2", "node-name": d.node,
				"file":    map[string]any{"driver": "file", "filename": d.file},
				"backing": d.src,
			}, nil); err != nil {
				return fmt.Errorf("adding the fleecing image of %s: %w", d.key, err)
			}
		}
		return nil
	})
	if err != nil {
		return fail(err)
	}

	frozen := false
	if freeze {
		if _, err := pveRun(ctx, "qm", "guest", "cmd", strconv.Itoa(vmid), "fsfreeze-freeze"); err != nil {
			logf("freezing the guest filesystems failed, the backup is crash-consistent: %v", err)
		} else {
			frozen = true
		}
	}
	// One transaction: every disk shows the same moment.
	err = p.withQMP(ctx, vmid, func(c *qmpClient, _ []qmpBlockInfo) error {
		var actions []map[string]any
		for _, d := range disks {
			actions = append(actions, map[string]any{"type": "blockdev-backup", "data": map[string]any{
				"job-id": d.node, "device": d.src, "target": d.node, "sync": "none",
			}})
		}
		return c.Execute("transaction", map[string]any{"actions": actions}, nil)
	})
	if frozen {
		tctx, cancel := bg()
		if _, terr := pveRun(tctx, "qm", "guest", "cmd", strconv.Itoa(vmid), "fsfreeze-thaw"); terr != nil {
			logf("thawing the guest filesystems failed: %v", terr)
		}
		cancel()
	}
	if err != nil {
		return fail(fmt.Errorf("starting the copy-before-write jobs: %w", err))
	}

	sockDir, err = os.MkdirTemp("", "amber-nbd-")
	if err != nil {
		return fail(err)
	}
	sock := filepath.Join(sockDir, "fleece.sock")
	err = p.withQMP(ctx, vmid, func(c *qmpClient, _ []qmpBlockInfo) error {
		if err := c.Execute("nbd-server-start", nbdServerStartArgs(sock), nil); err != nil {
			return fmt.Errorf("starting QEMU's NBD server: %w", err)
		}
		for _, d := range disks {
			if err := c.Execute("block-export-add", map[string]any{
				"type": "nbd", "id": d.node, "node-name": d.node, "name": d.node, "writable": false,
			}, nil); err != nil {
				return fmt.Errorf("exporting the fleecing view of %s: %w", d.key, err)
			}
		}
		return nil
	})
	if err != nil {
		return fail(err)
	}
	st := &fleeceState{sock: sock, nodes: map[string]string{}}
	for _, d := range disks {
		st.nodes[d.key] = d.src
	}
	p.setFleece(vmid, st)
	for _, d := range disks {
		cctx, cancel := context.WithTimeout(ctx, time.Minute)
		nc, err := nbdConnect(cctx, sock, d.node, "")
		cancel()
		if err != nil {
			return fail(fmt.Errorf("reading the fleecing view of %s: %w", d.key, err))
		}
		readers[d.key] = &nbdDisk{c: nc, stop: func() {}}
	}
	out := make(map[string]pveDiskReader, len(readers))
	for k, r := range readers {
		out[k] = r
	}
	// The caller closes the readers; cleanup must not close them twice.
	clear(readers)
	return out, cleanup, frozen, nil
}

func (p *realPve) CleanupFleecing(ctx context.Context, vmid int) error {
	p.setFleece(vmid, nil)
	files, _ := filepath.Glob(filepath.Join(fleeceDir(), strconv.Itoa(vmid)+"-*.qcow2"))
	err := p.withQMP(ctx, vmid, func(c *qmpClient, _ []qmpBlockInfo) error {
		var first error
		keep := func(err error) {
			if err != nil && first == nil {
				first = err
			}
		}
		var exports []struct {
			ID string `json:"id"`
		}
		ours := false
		if err := c.Execute("query-block-exports", nil, &exports); err == nil {
			for _, e := range exports {
				if strings.HasPrefix(e.ID, fleecePrefix) {
					ours = true
					keep(c.Execute("block-export-del", map[string]any{"id": e.ID, "mode": "hard"}, nil))
				}
			}
		}
		var jobs []struct {
			Device string `json:"device"`
		}
		hasJobs := func() bool {
			jobs = nil
			c.Execute("query-block-jobs", nil, &jobs)
			for _, j := range jobs {
				if strings.HasPrefix(j.Device, fleecePrefix) {
					return true
				}
			}
			return false
		}
		if hasJobs() {
			ours = true
			for _, j := range jobs {
				if strings.HasPrefix(j.Device, fleecePrefix) {
					keep(c.Execute("block-job-cancel", map[string]any{"device": j.Device, "force": true}, nil))
				}
			}
			for i := 0; i < 150 && hasJobs(); i++ {
				time.Sleep(200 * time.Millisecond)
			}
			if hasJobs() {
				keep(errors.New("a copy-before-write job did not end"))
			}
		}
		var nodes []struct {
			NodeName string `json:"node-name"`
		}
		if err := c.Execute("query-named-block-nodes", map[string]any{"flat": true}, &nodes); err == nil {
			for _, n := range nodes {
				if strings.HasPrefix(n.NodeName, fleecePrefix) {
					ours = true
					keep(c.Execute("blockdev-del", map[string]any{"node-name": n.NodeName}, nil))
				}
			}
		}
		// The NBD server was ours while our exports or nodes existed.
		if ours || len(files) > 0 {
			c.Execute("nbd-server-stop", nil, nil)
		}
		return first
	})
	if err != nil && !vmNotRunning(vmid) {
		return err
	}
	// Images QEMU no longer holds (or a stopped VM's) can go.
	for _, f := range files {
		os.Remove(f)
	}
	return nil
}

// vmNotRunning: without a QMP socket there is no QEMU holding anything.
func vmNotRunning(vmid int) bool {
	_, err := os.Stat(qmpSocket(vmid))
	return errors.Is(err, os.ErrNotExist)
}

func (p *realPve) OpenVolume(ctx context.Context, d ProxmoxGuestDisk) (pveDiskReader, error) {
	path, err := pveRun(ctx, "pvesm", "path", d.Volid)
	if err != nil {
		return nil, err
	}
	return openDevice(path, nil)
}

// fmtBytesIEC formats a byte count for messages (1.5 GiB).
func fmtBytesIEC(n int64) string {
	const unit = 1024
	if n < unit {
		return strconv.FormatInt(n, 10) + " B"
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
