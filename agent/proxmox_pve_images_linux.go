//go:build linux

package main

// Real-backend parts of file restores from VM backups and live restores:
// attaching a disk image's filesystems read-only (loop device + mount),
// qcow2 overlays, registering a VM from a config and `qm disk move`.
// Like the rest of the real backend, none of it has run on a PVE host yet.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type lsblkDev struct {
	Path     string     `json:"path"`
	FSType   *string    `json:"fstype"`
	Type     string     `json:"type"`
	PartN    *int       `json:"partn"`
	Children []lsblkDev `json:"children"`
}

// fsMountOptions are the read-only mount options per filesystem type; ""
// means Amber doesn't mount it.
// ASSUMPTION(pve): the node has the kernel modules for these filesystems
// (ext4, xfs, btrfs, vfat, ntfs3 — PVE's kernel ships them).
func fsMountOptions(fstype string) (types []string, opts string) {
	switch fstype {
	case "ext2", "ext3", "ext4":
		// noload: never replay the journal of a crash-consistent image.
		return []string{fstype}, "ro,noload"
	case "xfs":
		// nouuid: the guest's filesystem may share its UUID with another one.
		return []string{"xfs"}, "ro,norecovery,nouuid"
	case "btrfs":
		return []string{"btrfs"}, "ro,rescue=nologreplay"
	case "vfat":
		return []string{"vfat"}, "ro"
	case "ntfs":
		return []string{"ntfs3", "ntfs-3g"}, "ro"
	}
	return nil, ""
}

func (p *realPve) AttachImage(ctx context.Context, vmid int, key, image, workdir string) ([]pveGuestPartition, []string, func() error, error) {
	// ASSUMPTION(pve): losetup can back a read-only loop device by a file on
	// FUSE and scans its partition table (--partscan → /dev/loopNpM).
	dev, err := pveRun(ctx, "losetup", "--read-only", "--find", "--show", "--partscan", image)
	if err != nil {
		return nil, nil, nil, err
	}
	var undo []func() error
	detach := func() error {
		var errs []error
		for i := len(undo) - 1; i >= 0; i-- {
			if err := undo[i](); err != nil {
				errs = append(errs, err)
			}
		}
		c, cancel := bg()
		defer cancel()
		if _, err := pveRun(c, "losetup", "--detach", dev); err != nil {
			errs = append(errs, err)
		}
		return errors.Join(errs...)
	}
	// Partition devices appear through udev.
	pveRun(ctx, "udevadm", "settle", "--timeout=30")
	out, err := pveRun(ctx, "lsblk", "--json", "--output", "PATH,FSTYPE,TYPE,PARTN", dev)
	if err != nil {
		detach()
		return nil, nil, nil, err
	}
	var tree struct {
		Blockdevices []lsblkDev `json:"blockdevices"`
	}
	if err := json.Unmarshal([]byte(out), &tree); err != nil || len(tree.Blockdevices) != 1 {
		detach()
		return nil, nil, nil, fmt.Errorf("reading the partitions of %s: %v", dev, err)
	}
	root := tree.Blockdevices[0]
	cands := []lsblkDev{}
	if root.FSType != nil && *root.FSType != "" {
		cands = append(cands, root) // a filesystem on the whole disk
	}
	cands = append(cands, root.Children...)
	var parts []pveGuestPartition
	var warns []string
	for _, c := range cands {
		idx := 0
		if c.PartN != nil {
			idx = *c.PartN
		}
		fstype := ""
		if c.FSType != nil {
			fstype = *c.FSType
		}
		name := fmt.Sprintf("%s-p%d", key, idx)
		switch fstype {
		case "":
			continue
		case "LVM2_member":
			// Activating a guest's volume group on the host risks clashing
			// with host VGs of the same name; left out on purpose.
			warns = append(warns, name+": LVM physical volume — not mounted (restore the VM to reach it)")
			continue
		case "swap":
			continue
		}
		types, opts := fsMountOptions(fstype)
		if types == nil {
			warns = append(warns, fmt.Sprintf("%s: filesystem %s is not supported", name, fstype))
			continue
		}
		dir := filepath.Join(workdir, name)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			detach()
			return nil, nil, nil, err
		}
		var merr error
		for _, typ := range types {
			if _, merr = pveRun(ctx, "mount", "-t", typ, "-o", opts, c.Path, dir); merr == nil {
				break
			}
		}
		if merr != nil {
			warns = append(warns, fmt.Sprintf("%s: mounting %s failed: %v", name, fstype, merr))
			continue
		}
		undo = append(undo, func() error {
			c, cancel := bg()
			defer cancel()
			if _, err := pveRun(c, "umount", dir); err != nil {
				_, err = pveRun(c, "umount", "-l", dir)
				return err
			}
			return nil
		})
		parts = append(parts, pveGuestPartition{Disk: key, Index: idx, FSType: fstype, Dir: dir})
	}
	return parts, warns, detach, nil
}

// overlayVolid is the volume of a live restore's overlay for a disk.
func overlayVolid(storage string, vmid int, key string) string {
	return fmt.Sprintf("%s:%d/vm-%d-amberlive-%s.qcow2", storage, vmid, vmid, key)
}

func (p *realPve) CreateOverlay(ctx context.Context, storage string, vmid int, key, image string, size int64) (string, error) {
	volid := overlayVolid(storage, vmid, key)
	// ASSUMPTION(pve): `pvesm path` resolves a not yet existing volume of a
	// dir-like storage to <path>/images/<vmid>/<name>, and PVE accepts any
	// vm-<vmid>-*.qcow2 name there as a volume of that VM.
	path, err := pveRun(ctx, "pvesm", "path", volid)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if _, err := os.Stat(path); err == nil {
		return "", fmt.Errorf("%s already exists", path)
	}
	// ASSUMPTION(pve): QEMU on the node reads the absolute FUSE path of the
	// raw image as backing file (root, no AppArmor confinement of QEMU).
	if _, err := pveRun(ctx, "qemu-img", "create", "-f", "qcow2", "-F", "raw", "-b", image, path, strconv.FormatInt(size, 10)); err != nil {
		return "", err
	}
	return volid, nil
}

func (p *realPve) FreeVolume(ctx context.Context, volid string) error {
	_, err := pveRun(ctx, "pvesm", "free", volid)
	return err
}

func (p *realPve) WriteGuestConfig(ctx context.Context, vmid int, text string) error {
	// ASSUMPTION(pve): /etc/pve/qemu-server is this node's config directory
	// and pmxcfs honours O_EXCL, so an existing VMID is never overwritten.
	path := filepath.Join(pveEtc, "qemu-server", strconv.Itoa(vmid)+".conf")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(f, text); err != nil {
		f.Close()
		os.Remove(path)
		return err
	}
	return f.Close()
}

func (p *realPve) DestroyGuest(ctx context.Context, typ string, vmid int) error {
	_, err := pveRun(ctx, guestTool(typ), "destroy", strconv.Itoa(vmid), "--skiplock", "1")
	return err
}

func (p *realPve) MoveDisk(ctx context.Context, vmid int, key, storage string, onProgress func(done, total int64)) error {
	// ASSUMPTION(pve): `qm disk move <vmid> <disk> <storage> --delete 1`
	// mirrors a running VM's disk (block job), removes the source volume and
	// prints "transferred X GiB of Y GiB" progress lines.
	cmd := exec.CommandContext(ctx, "qm", "disk", "move", strconv.Itoa(vmid), key, storage, "--delete", "1")
	cmd.WaitDelay = 30 * time.Second
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	if err := cmd.Start(); err != nil {
		return err
	}
	var tail []string
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(pr)
		for sc.Scan() {
			line := sc.Text()
			if d, t, ok := parseTransferred(line); ok {
				onProgress(d, t)
				continue
			}
			tail = append(tail, line)
			if len(tail) > 20 {
				tail = tail[1:]
			}
		}
		io.Copy(io.Discard, pr)
	}()
	err := cmd.Wait()
	pw.Close()
	<-done
	if err != nil {
		return fmt.Errorf("qm disk move: %v: %s", err, strings.Join(tail, "; "))
	}
	return nil
}
