//go:build linux

package main

// The read-only FUSE filesystem that serves a segmentView (see
// proxmox_segments.go). Directories under disks/<key>/ and the segment files
// are created lazily on lookup, so even a multi-TiB disk costs little memory.

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

const (
	fileMode = syscall.S_IFREG | 0o444
	dirMode  = syscall.S_IFDIR | 0o555
)

func setTimes(out *fuse.Attr, t time.Time) {
	out.SetTimes(&t, &t, &t)
}

type segRoot struct {
	fs.Inode
	view *segmentView
}

type segStatic struct {
	fs.Inode
	view *segmentView
	data []byte
}

type segDisksDir struct {
	fs.Inode
	view *segmentView
}

type segKeyDir struct {
	fs.Inode
	view *segmentView
	disk *segDisk
	di   int
}

type segSubDir struct {
	fs.Inode
	view   *segmentView
	disk   *segDisk
	di     int
	dirIdx int64
}

type segFile struct {
	fs.Inode
	view *segmentView
	disk *segDisk
	idx  int64
}

var (
	_ fs.NodeOnAdder   = (*segRoot)(nil)
	_ fs.NodeGetattrer = (*segRoot)(nil)
	_ fs.NodeGetattrer = (*segStatic)(nil)
	_ fs.NodeOpener    = (*segStatic)(nil)
	_ fs.NodeReader    = (*segStatic)(nil)
	_ fs.NodeOnAdder   = (*segDisksDir)(nil)
	_ fs.NodeGetattrer = (*segDisksDir)(nil)
	_ fs.NodeLookuper  = (*segKeyDir)(nil)
	_ fs.NodeReaddirer = (*segKeyDir)(nil)
	_ fs.NodeGetattrer = (*segKeyDir)(nil)
	_ fs.NodeLookuper  = (*segSubDir)(nil)
	_ fs.NodeReaddirer = (*segSubDir)(nil)
	_ fs.NodeGetattrer = (*segSubDir)(nil)
	_ fs.NodeGetattrer = (*segFile)(nil)
	_ fs.NodeOpener    = (*segFile)(nil)
	_ fs.NodeReader    = (*segFile)(nil)
)

// Inode numbers: static files 2..; disk dirs, sub dirs and files in ranges
// keyed by the disk index so they never collide.
func inoKeyDir(di int) uint64             { return 1<<20 + uint64(di) }
func inoSubDir(di int, dir int64) uint64  { return uint64(di+1)<<56 | 1<<55 | uint64(dir) }
func inoSegFile(di int, idx int64) uint64 { return uint64(di+1)<<56 | uint64(idx) }

func (r *segRoot) OnAdd(ctx context.Context) {
	for i, name := range r.view.staticNames() {
		ch := r.NewPersistentInode(ctx, &segStatic{view: r.view, data: r.view.Files[name]},
			fs.StableAttr{Mode: fileMode, Ino: uint64(2 + i)})
		r.AddChild(name, ch, false)
	}
	if len(r.view.Disks) > 0 {
		ch := r.NewPersistentInode(ctx, &segDisksDir{view: r.view}, fs.StableAttr{Mode: dirMode, Ino: 1 << 19})
		r.AddChild("disks", ch, false)
	}
}

func (r *segRoot) Getattr(ctx context.Context, fh fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Mode = dirMode
	setTimes(&out.Attr, r.view.Now)
	return 0
}

func (s *segStatic) Getattr(ctx context.Context, fh fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Mode = fileMode
	out.Size = uint64(len(s.data))
	setTimes(&out.Attr, s.view.Now)
	return 0
}

func (s *segStatic) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if flags&(syscall.O_WRONLY|syscall.O_RDWR) != 0 {
		return nil, 0, syscall.EROFS
	}
	return nil, fuse.FOPEN_KEEP_CACHE, 0
}

func (s *segStatic) Read(ctx context.Context, fh fs.FileHandle, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	if off >= int64(len(s.data)) {
		return fuse.ReadResultData(nil), 0
	}
	end := off + int64(len(dest))
	if end > int64(len(s.data)) {
		end = int64(len(s.data))
	}
	return fuse.ReadResultData(s.data[off:end]), 0
}

func (d *segDisksDir) OnAdd(ctx context.Context) {
	for i, disk := range d.view.Disks {
		ch := d.NewPersistentInode(ctx, &segKeyDir{view: d.view, disk: disk, di: i},
			fs.StableAttr{Mode: dirMode, Ino: inoKeyDir(i)})
		d.AddChild(disk.Key, ch, false)
	}
}

func (d *segDisksDir) Getattr(ctx context.Context, fh fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Mode = dirMode
	var max time.Time
	for _, disk := range d.view.Disks {
		if m := d.view.diskMtime(disk); m.After(max) {
			max = m
		}
	}
	setTimes(&out.Attr, max)
	return 0
}

func (k *segKeyDir) dirCount() int64 {
	return (int64(len(k.disk.Mtimes)) + pveSegmentsPerDir - 1) / pveSegmentsPerDir
}

func (k *segKeyDir) Getattr(ctx context.Context, fh fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Mode = dirMode
	setTimes(&out.Attr, k.view.diskMtime(k.disk))
	return 0
}

func (k *segKeyDir) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	n, err := strconv.ParseInt(name, 10, 64)
	if err != nil || len(name) != 4 || n < 0 || n >= k.dirCount() {
		return nil, syscall.ENOENT
	}
	sub := &segSubDir{view: k.view, disk: k.disk, di: k.di, dirIdx: n}
	out.Mode = dirMode
	setTimes(&out.Attr, k.view.dirMtime(k.disk, n))
	return k.NewInode(ctx, sub, fs.StableAttr{Mode: dirMode, Ino: inoSubDir(k.di, n)}), 0
}

func (k *segKeyDir) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	var list []fuse.DirEntry
	for i := int64(0); i < k.dirCount(); i++ {
		list = append(list, fuse.DirEntry{Name: fmt.Sprintf("%04d", i), Mode: dirMode, Ino: inoSubDir(k.di, i)})
	}
	return fs.NewListDirStream(list), 0
}

func (s *segSubDir) Getattr(ctx context.Context, fh fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Mode = dirMode
	setTimes(&out.Attr, s.view.dirMtime(s.disk, s.dirIdx))
	return 0
}

func (s *segSubDir) segRange() (int64, int64) {
	first := s.dirIdx * pveSegmentsPerDir
	last := first + pveSegmentsPerDir
	if n := int64(len(s.disk.Mtimes)); last > n {
		last = n
	}
	return first, last
}

func (s *segSubDir) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	base, ok := strings.CutSuffix(name, ".seg")
	n, err := strconv.ParseInt(base, 10, 64)
	first, last := s.segRange()
	idx := first + n
	if !ok || err != nil || len(base) != 3 || n < 0 || idx >= last {
		return nil, syscall.ENOENT
	}
	f := &segFile{view: s.view, disk: s.disk, idx: idx}
	f.fill(&out.Attr)
	return s.NewInode(ctx, f, fs.StableAttr{Mode: fileMode, Ino: inoSegFile(s.di, idx)}), 0
}

func (s *segSubDir) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	first, last := s.segRange()
	var list []fuse.DirEntry
	for i := first; i < last; i++ {
		list = append(list, fuse.DirEntry{Name: fmt.Sprintf("%03d.seg", i-first), Mode: fileMode, Ino: inoSegFile(s.di, i)})
	}
	return fs.NewListDirStream(list), 0
}

func (f *segFile) fill(a *fuse.Attr) {
	a.Mode = fileMode
	a.Size = uint64(segmentLen(f.disk.Size, f.view.SegBytes, f.idx))
	a.Blksize = 1 << 16
	setTimes(a, f.disk.Mtimes[f.idx])
}

func (f *segFile) Getattr(ctx context.Context, fh fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	f.fill(&out.Attr)
	return 0
}

func (f *segFile) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if flags&(syscall.O_WRONLY|syscall.O_RDWR) != 0 {
		return nil, 0, syscall.EROFS
	}
	return nil, 0, 0
}

func (f *segFile) Read(ctx context.Context, fh fs.FileHandle, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	n, err := f.view.readSegment(f.disk, f.idx, dest, off)
	if err != nil {
		return nil, syscall.EIO
	}
	return fuse.ReadResultData(dest[:n]), 0
}

// mountSegmentView serves view read-only at dir until the returned func
// unmounts it.
func mountSegmentView(dir string, view *segmentView) (func() error, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	timeout := time.Minute
	server, err := fs.Mount(dir, &segRoot{view: view}, &fs.Options{
		MountOptions: fuse.MountOptions{
			FsName:       "amber-pve",
			Name:         "amberseg",
			Options:      []string{"ro"},
			MaxReadAhead: 1 << 20,
		},
		EntryTimeout: &timeout,
		AttrTimeout:  &timeout,
		UID:          uint32(os.Getuid()),
		GID:          uint32(os.Getgid()),
	})
	if err != nil {
		return nil, fmt.Errorf("mounting the segment view at %s: %w", dir, err)
	}
	return func() error {
		err := server.Unmount()
		if err != nil {
			// A reader still holding a file (restic killed mid-way) — detach.
			if derr := unmountDetach(dir); derr == nil {
				err = nil
			}
		}
		server.Wait()
		return err
	}, nil
}

// mountsBelow lists the mount points at or below dir (deepest first).
func mountsBelow(dir string) []string {
	f, err := os.Open("/proc/self/mounts")
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		mp := unescapeMount(fields[1])
		if mp == dir || strings.HasPrefix(mp, dir+"/") {
			out = append(out, mp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return len(out[i]) > len(out[j]) })
	return out
}

func unescapeMount(s string) string {
	r := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	return r.Replace(s)
}

// unmountDetach lazily unmounts dir: as root with umount(2), otherwise (a
// FUSE mount of an unprivileged agent, e.g. in tests) with fusermount.
func unmountDetach(dir string) error {
	if err := syscall.Unmount(dir, syscall.MNT_DETACH); err == nil {
		return nil
	}
	for _, bin := range []string{"fusermount3", "fusermount"} {
		if p, err := exec.LookPath(bin); err == nil {
			if exec.Command(p, "-u", "-z", dir).Run() == nil {
				return nil
			}
		}
	}
	return fmt.Errorf("could not unmount %s", dir)
}

// cleanupMountsBelow unmounts whatever a crashed run left mounted under dir.
func cleanupMountsBelow(dir string) []string {
	var done []string
	for _, mp := range mountsBelow(dir) {
		if unmountDetach(mp) == nil {
			done = append(done, mp)
		}
	}
	return done
}
