package main

import (
	"bytes"
	"testing"
	"time"
)

func TestSegmentLayout(t *testing.T) {
	const seg = 16 << 20
	if segmentCount(40<<20, seg) != 3 || segmentCount(32<<20, seg) != 2 || segmentCount(0, seg) != 0 {
		t.Fatal("segment count")
	}
	if segmentLen(40<<20, seg, 2) != 8<<20 || segmentLen(40<<20, seg, 0) != seg || segmentLen(40<<20, seg, 3) != 0 {
		t.Fatal("segment len")
	}
	if segmentPath("scsi0", 0) != "disks/scsi0/0000/000.seg" || segmentPath("scsi0", 257) != "disks/scsi0/0001/001.seg" {
		t.Fatalf("paths %s %s", segmentPath("scsi0", 0), segmentPath("scsi0", 257))
	}
}

func TestDirtySegments(t *testing.T) {
	const seg = 100
	got := dirtySegments([]pveExtent{{Offset: 0, Length: 1}, {Offset: 150, Length: 100}, {Offset: 990, Length: 500}, {Offset: 500, Length: 0}}, 1000, seg)
	want := map[int64]bool{0: true, 1: true, 2: true, 9: true}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for k := range want {
		if !got[k] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestPlanSegmentMtimes(t *testing.T) {
	const seg = 100
	root := "/run/amber-agent/pve/100"
	old := time.Date(2026, 1, 2, 3, 4, 5, 678, time.UTC)
	now := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	parent := map[string]segParentInfo{
		root + "/disks/scsi0/0000/000.seg": {Mtime: old, Size: 100},
		root + "/disks/scsi0/0000/001.seg": {Mtime: old, Size: 100},
		root + "/disks/scsi0/0000/002.seg": {Mtime: old, Size: 40}, // was shorter: disk grew
	}
	// Change tracking: segment 1 dirty.
	mt, read := planSegmentMtimes(root, "scsi0", 300, seg, map[int64]bool{1: true}, parent, now)
	if !mt[0].Equal(old) || !mt[1].Equal(now) || !mt[2].Equal(now) || read != 2 {
		t.Fatalf("incremental: %v read %d", mt, read)
	}
	// Full read: everything new.
	mt, read = planSegmentMtimes(root, "scsi0", 300, seg, nil, parent, now)
	if read != 3 || !mt[0].Equal(now) {
		t.Fatalf("full: %v read %d", mt, read)
	}
	// Another disk has no parent entries: read.
	_, read = planSegmentMtimes(root, "scsi1", 300, seg, map[int64]bool{}, parent, now)
	if read != 3 {
		t.Fatal("unknown segments are read")
	}
}

func TestReadSegment(t *testing.T) {
	data := make([]byte, 250)
	for i := range data {
		data[i] = byte(i)
	}
	v := &segmentView{SegBytes: 100}
	d := &segDisk{Key: "x", Size: 250, Reader: bytes.NewReader(data)}
	buf := make([]byte, 80)
	n, err := v.readSegment(d, 2, buf, 10)
	if err != nil || n != 40 || buf[0] != 210 {
		t.Fatalf("n=%d err=%v first=%d", n, err, buf[0])
	}
	if n, _ := v.readSegment(d, 2, buf, 50); n != 0 {
		t.Fatal("read past the segment")
	}
	if v.BytesRead.Load() != 40 {
		t.Fatalf("bytes read %d", v.BytesRead.Load())
	}
}
