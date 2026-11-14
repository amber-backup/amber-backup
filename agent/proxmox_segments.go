package main

// The block method's segment view: each disk of a VM snapshot is presented as
// fixed-size segment files (disks/<key>/<dir %04d>/<seg %03d>.seg, 256 per
// directory). restic backs the view up with --parent --ignore-inode
// --ignore-ctime, so it reads exactly the segments whose mtime differs from
// the parent snapshot — unchanged segments keep the parent's mtime and reuse
// its blobs. This file holds the portable part (layout, mtime planning); the
// FUSE filesystem serving it is proxmox_segfs_linux.go.

import (
	"fmt"
	"io"
	"path"
	"sort"
	"sync/atomic"
	"time"
)

// pveExtent is a byte range of a disk; Dirty for change tracking.
type pveExtent struct {
	Offset int64 `json:"offset"`
	Length int64 `json:"length"`
}

// segParentInfo is a segment as the parent snapshot holds it.
type segParentInfo struct {
	Mtime time.Time
	Size  int64
}

// segDisk is one disk in the view.
type segDisk struct {
	Key    string
	Size   int64
	Reader io.ReaderAt
	// Mtimes per segment (len = segment count).
	Mtimes []time.Time
}

// segmentView is everything the FUSE filesystem serves.
type segmentView struct {
	SegBytes int64
	// Static files at the root (manifest.json, qemu-server.conf).
	Files map[string][]byte
	Disks []*segDisk
	// Time of the static files and directories without segments.
	Now time.Time
	// Bytes read from the disks so far (what the backup really read).
	BytesRead atomic.Int64
}

func segmentCount(size, seg int64) int64 {
	if size <= 0 {
		return 0
	}
	return (size + seg - 1) / seg
}

// segmentRelPath is a segment's path below disks/<key>/.
func segmentRelPath(idx int64) string {
	return fmt.Sprintf("%04d/%03d.seg", idx/pveSegmentsPerDir, idx%pveSegmentsPerDir)
}

// segmentPath is a segment's path below the view's root.
func segmentPath(key string, idx int64) string {
	return path.Join("disks", key, segmentRelPath(idx))
}

// segmentLen is the length of segment idx of a disk.
func segmentLen(size, seg, idx int64) int64 {
	n := size - idx*seg
	if n > seg {
		return seg
	}
	if n < 0 {
		return 0
	}
	return n
}

// dirtySegments maps dirty extents to the indexes of the segments they touch.
func dirtySegments(extents []pveExtent, size, seg int64) map[int64]bool {
	out := map[int64]bool{}
	for _, e := range extents {
		if e.Length <= 0 {
			continue
		}
		end := e.Offset + e.Length
		if end > size {
			end = size
		}
		for i := e.Offset / seg; i*seg < end; i++ {
			out[i] = true
		}
	}
	return out
}

// planSegmentMtimes decides each segment's mtime. With change tracking
// (dirty != nil) a clean segment keeps its parent mtime when the parent has it
// with the same size; everything else — dirty, new, resized, or every segment
// on a full read (dirty == nil) — gets now, so restic reads it.
// It returns the mtimes and how many segments will be read.
func planSegmentMtimes(root, key string, size, seg int64, dirty map[int64]bool, parent map[string]segParentInfo, now time.Time) ([]time.Time, int64) {
	n := segmentCount(size, seg)
	out := make([]time.Time, n)
	var read int64
	for i := int64(0); i < n; i++ {
		out[i] = now
		if dirty != nil && !dirty[i] {
			if p, ok := parent[path.Join(root, segmentPath(key, i))]; ok && p.Size == segmentLen(size, seg, i) && !p.Mtime.Equal(now) {
				out[i] = p.Mtime
				continue
			}
		}
		read++
	}
	return out, read
}

// readSegment reads from segment idx of d at off into dest; it returns the
// bytes read (0 at the segment's end).
func (v *segmentView) readSegment(d *segDisk, idx int64, dest []byte, off int64) (int, error) {
	l := segmentLen(d.Size, v.SegBytes, idx)
	if off >= l {
		return 0, nil
	}
	if int64(len(dest)) > l-off {
		dest = dest[:l-off]
	}
	n, err := d.Reader.ReadAt(dest, idx*v.SegBytes+off)
	if err == io.EOF && n == len(dest) {
		err = nil
	}
	v.BytesRead.Add(int64(n))
	return n, err
}

// dirMtime is the newest segment mtime in segment directory dirIdx of d (the
// directory's mtime: stable while none of its segments change).
func (v *segmentView) dirMtime(d *segDisk, dirIdx int64) time.Time {
	var max time.Time
	for i := dirIdx * pveSegmentsPerDir; i < (dirIdx+1)*pveSegmentsPerDir && i < int64(len(d.Mtimes)); i++ {
		if d.Mtimes[i].After(max) {
			max = d.Mtimes[i]
		}
	}
	if max.IsZero() {
		return v.Now
	}
	return max
}

func (v *segmentView) diskMtime(d *segDisk) time.Time {
	var max time.Time
	for _, m := range d.Mtimes {
		if m.After(max) {
			max = m
		}
	}
	if max.IsZero() {
		return v.Now
	}
	return max
}

func (v *segmentView) staticNames() []string {
	names := make([]string, 0, len(v.Files))
	for n := range v.Files {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}
