package main

// A block snapshot stores each VM disk as segment files
// (disks/<key>/<dir>/<seg>.seg, see proxmox_segments.go). File restores from
// VM backups and live restores need the disk as one raw image again: a
// concatImage maps image offsets onto the segment files below a directory —
// a `restic mount` of the snapshot — and zero-fills missing or short
// segments. proxmox_concatfs_linux.go serves such images through FUSE.
//
// Also here: the guest path selectors of a vm-files restore and the copy of
// matched paths out of mounted guest filesystems.

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// concatImage is one disk of a block snapshot as a raw image.
type concatImage struct {
	// Directory holding disks/<key>/… (the snapshot root inside a restic mount).
	Root     string
	Key      string
	Size     int64
	SegBytes int64

	mu    sync.Mutex
	open  map[int64]*os.File
	order []int64 // LRU of open segment files, oldest first
}

const concatMaxOpen = 8

func newConcatImage(root, key string, size, segBytes int64) *concatImage {
	return &concatImage{Root: root, Key: key, Size: size, SegBytes: segBytes, open: map[int64]*os.File{}}
}

// segFile returns the open segment file idx, nil when the snapshot lacks it.
func (c *concatImage) segFile(idx int64) (*os.File, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if f, ok := c.open[idx]; ok {
		for i, v := range c.order {
			if v == idx {
				c.order = append(append(c.order[:i:i], c.order[i+1:]...), idx)
				break
			}
		}
		return f, nil
	}
	f, err := os.Open(filepath.Join(c.Root, filepath.FromSlash(segmentPath(c.Key, idx))))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(c.order) >= concatMaxOpen {
		old := c.order[0]
		c.order = c.order[1:]
		c.open[old].Close()
		delete(c.open, old)
	}
	c.open[idx] = f
	c.order = append(c.order, idx)
	return f, nil
}

// ReadAt reads the image; bytes no segment holds read as zeros.
func (c *concatImage) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 {
		return 0, errors.New("negative offset")
	}
	if off >= c.Size {
		return 0, io.EOF
	}
	want := len(p)
	if rest := c.Size - off; int64(want) > rest {
		want = int(rest)
	}
	n := 0
	for n < want {
		pos := off + int64(n)
		idx := pos / c.SegBytes
		within := pos % c.SegBytes
		chunk := int64(want - n)
		if left := segmentLen(c.Size, c.SegBytes, idx) - within; chunk > left {
			chunk = left
		}
		buf := p[n : n+int(chunk)]
		f, err := c.segFile(idx)
		if err != nil {
			return n, err
		}
		got := 0
		if f != nil {
			got, err = f.ReadAt(buf, within)
			if err != nil && err != io.EOF {
				return n, err
			}
		}
		clear(buf[got:]) // missing or short segment
		n += int(chunk)
	}
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func (c *concatImage) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, f := range c.open {
		f.Close()
	}
	c.open, c.order = map[int64]*os.File{}, nil
	return nil
}

// imageName is the file a disk's image is served as.
func imageName(key string) string { return key + ".raw" }

// --- vm-files selectors --------------------------------------------------------

// guestPathSel is one path of a vm-files restore: a path inside the guest,
// optionally limited to one disk and/or partition.
type guestPathSel struct {
	Disk string // "" = every disk
	Part int    // -1 = every partition; 0 = a filesystem on the whole disk
	Path string // absolute, cleaned
}

var (
	selDiskPartRE = regexp.MustCompile(`^([a-z]+[0-9]+)p([0-9]+):(.*)$`)
	selPartRE     = regexp.MustCompile(`^p([0-9]+):(.*)$`)
	selDiskRE     = regexp.MustCompile(`^([a-z]+[0-9]+):(.*)$`)
)

// parseGuestPath reads "p2:/etc/nginx", "scsi0p1:/home", "scsi0:/srv" or "/etc".
func parseGuestPath(s string) (guestPathSel, error) {
	s = strings.TrimSpace(s)
	sel := guestPathSel{Part: -1}
	rest := s
	if m := selDiskPartRE.FindStringSubmatch(s); m != nil {
		sel.Disk, rest = m[1], m[3]
		sel.Part, _ = strconv.Atoi(m[2])
	} else if m := selPartRE.FindStringSubmatch(s); m != nil {
		sel.Part, _ = strconv.Atoi(m[1])
		rest = m[2]
	} else if m := selDiskRE.FindStringSubmatch(s); m != nil {
		sel.Disk, rest = m[1], m[2]
	}
	if !strings.HasPrefix(rest, "/") {
		return sel, fmt.Errorf("%q: the path inside the guest must be absolute", s)
	}
	for _, part := range strings.Split(rest, "/") {
		if part == ".." {
			return sel, fmt.Errorf("%q: '..' is not allowed", s)
		}
	}
	sel.Path = path.Clean(rest)
	return sel, nil
}

// parseGuestPaths reads every selector; none means the whole of every partition.
func parseGuestPaths(in []string) ([]guestPathSel, error) {
	var out []guestPathSel
	for _, s := range in {
		if strings.TrimSpace(s) == "" {
			continue
		}
		sel, err := parseGuestPath(s)
		if err != nil {
			return nil, err
		}
		out = append(out, sel)
	}
	if len(out) == 0 {
		out = []guestPathSel{{Part: -1, Path: "/"}}
	}
	return out, nil
}

// pveGuestPartition is a guest filesystem the backend mounted read-only.
type pveGuestPartition struct {
	Disk   string
	Index  int // partition number, 0 = the whole disk
	FSType string
	Dir    string
}

func (p pveGuestPartition) Name() string { return fmt.Sprintf("%s-p%d", p.Disk, p.Index) }

func (s guestPathSel) matches(p pveGuestPartition) bool {
	return (s.Disk == "" || s.Disk == p.Disk) && (s.Part < 0 || s.Part == p.Index)
}

// copyStats counts what a copy wrote.
type copyStats struct {
	Files, Bytes int64
}

// copyGuestPaths copies every selected path that exists in a partition to
// target/<partition>/<path>. It reports which partitions matched; nothing
// matching anywhere is an error.
func copyGuestPaths(parts []pveGuestPartition, sels []guestPathSel, target string, appendLog func(string)) (copyStats, []string, error) {
	var st copyStats
	var used []string
	for _, p := range parts {
		matched := false
		for _, sel := range sels {
			if !sel.matches(p) {
				continue
			}
			src := filepath.Join(p.Dir, filepath.FromSlash(sel.Path))
			if _, err := os.Lstat(src); err != nil {
				continue
			}
			dst := filepath.Join(target, p.Name(), filepath.FromSlash(sel.Path))
			appendLog(fmt.Sprintf("copying %s:%s", p.Name(), sel.Path))
			if err := copyPreserving(src, dst, &st); err != nil {
				return st, used, fmt.Errorf("copying %s:%s: %w", p.Name(), sel.Path, err)
			}
			matched = true
		}
		if matched {
			used = append(used, p.Name())
		}
	}
	if len(used) == 0 {
		var names []string
		for _, p := range parts {
			names = append(names, p.Name()+" ("+p.FSType+")")
		}
		sort.Strings(names)
		if len(names) == 0 {
			return st, nil, errors.New("no mountable filesystem found on the VM's disks")
		}
		return st, nil, fmt.Errorf("none of the paths exists on the VM's filesystems: %s", strings.Join(names, ", "))
	}
	return st, used, nil
}

// copyPreserving copies a file or tree, keeping modes, times, symlinks and
// (as root) ownership. Devices, sockets and FIFOs are skipped.
func copyPreserving(src, dst string, st *copyStats) error {
	root, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	type dirTime struct {
		path string
		info fs.FileInfo
	}
	var dirs []dirTime
	walk := func(p string, info fs.FileInfo) error {
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		switch {
		case info.IsDir():
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			dirs = append(dirs, dirTime{target, info})
			return nil
		case info.Mode()&fs.ModeSymlink != 0:
			l, err := os.Readlink(p)
			if err != nil {
				return err
			}
			os.Remove(target)
			if err := os.Symlink(l, target); err != nil {
				return err
			}
			chownLike(target, info, true)
			st.Files++
			return nil
		case info.Mode().IsRegular():
			n, err := copyRegular(p, target, info)
			if err != nil {
				return err
			}
			st.Files++
			st.Bytes += n
			return nil
		default:
			return nil
		}
	}
	if root.IsDir() {
		err = filepath.Walk(src, func(p string, info fs.FileInfo, err error) error {
			if err != nil {
				return err
			}
			return walk(p, info)
		})
	} else {
		err = walk(src, root)
	}
	if err != nil {
		return err
	}
	// Directory modes and times last (writing into them changed the mtime).
	for i := len(dirs) - 1; i >= 0; i-- {
		d := dirs[i]
		os.Chmod(d.path, d.info.Mode().Perm())
		chownLike(d.path, d.info, false)
		os.Chtimes(d.path, d.info.ModTime(), d.info.ModTime())
	}
	return nil
}

func copyRegular(src, dst string, info fs.FileInfo) (int64, error) {
	in, err := os.Open(src)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	os.Remove(dst)
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return n, err
	}
	chownLike(dst, info, false)
	if err := os.Chmod(dst, info.Mode().Perm()|info.Mode()&(fs.ModeSetuid|fs.ModeSetgid|fs.ModeSticky)); err != nil {
		return n, err
	}
	return n, os.Chtimes(dst, info.ModTime(), info.ModTime())
}

// waitFor polls cond until it holds or the timeout passes.
func waitFor(timeout time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return cond()
}
