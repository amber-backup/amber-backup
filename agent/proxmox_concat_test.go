package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// writeSegments lays out a disk as segment files below root/disks/<key>/.
func writeSegments(t *testing.T, root, key string, data []byte, seg int64, skip map[int64]bool, short map[int64]int) {
	t.Helper()
	for idx := int64(0); idx*seg < int64(len(data)); idx++ {
		if skip[idx] {
			continue
		}
		end := (idx + 1) * seg
		if end > int64(len(data)) {
			end = int64(len(data))
		}
		chunk := data[idx*seg : end]
		if n, ok := short[idx]; ok {
			chunk = chunk[:n]
		}
		p := filepath.Join(root, filepath.FromSlash(segmentPath(key, idx)))
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, chunk, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestConcatImageMapsOffsetsOntoSegments(t *testing.T) {
	root := t.TempDir()
	const seg = 16
	data := make([]byte, 16*300+5) // 301 segments → crosses a segment directory (256)
	for i := range data {
		data[i] = byte(i*7 + 1)
	}
	// Segment 3 is missing (reads as zeros), segment 4 is short by 6 bytes.
	writeSegments(t, root, "scsi0", data, seg, map[int64]bool{3: true}, map[int64]int{4: 10})
	want := append([]byte(nil), data...)
	clear(want[3*seg : 4*seg])
	clear(want[4*seg+10 : 5*seg])

	img := newConcatImage(root, "scsi0", int64(len(data)), seg)
	defer img.Close()

	got, err := io.ReadAll(io.NewSectionReader(img, 0, img.Size))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("full read differs")
	}
	// Reads across segment boundaries and into the directory change.
	for _, c := range []struct{ off, n int64 }{{0, 1}, {14, 5}, {40, 40}, {255*16 - 3, 9}, {int64(len(data)) - 7, 7}} {
		buf := make([]byte, c.n)
		n, err := img.ReadAt(buf, c.off)
		if err != nil || int64(n) != c.n || !bytes.Equal(buf, want[c.off:c.off+c.n]) {
			t.Fatalf("ReadAt(%d,%d) = %d %v", c.off, c.n, n, err)
		}
	}
	// A read past the end is short with io.EOF.
	buf := make([]byte, 10)
	n, err := img.ReadAt(buf, int64(len(data))-4)
	if n != 4 || err != io.EOF || !bytes.Equal(buf[:4], want[len(want)-4:]) {
		t.Fatalf("tail read %d %v", n, err)
	}
	if _, err := img.ReadAt(buf, int64(len(data))); err != io.EOF {
		t.Fatalf("read at the end: %v", err)
	}
	if len(img.open) > concatMaxOpen {
		t.Fatalf("%d segment files open", len(img.open))
	}
}

func TestParseGuestPath(t *testing.T) {
	cases := []struct {
		in   string
		want guestPathSel
	}{
		{"/etc/nginx", guestPathSel{Part: -1, Path: "/etc/nginx"}},
		{"p2:/etc/nginx/", guestPathSel{Part: 2, Path: "/etc/nginx"}},
		{"scsi0p1:/home", guestPathSel{Disk: "scsi0", Part: 1, Path: "/home"}},
		{"virtio1:/srv", guestPathSel{Disk: "virtio1", Part: -1, Path: "/srv"}},
		{"scsi0p0:/", guestPathSel{Disk: "scsi0", Part: 0, Path: "/"}},
	}
	for _, c := range cases {
		got, err := parseGuestPath(c.in)
		if err != nil || got != c.want {
			t.Errorf("%q → %+v %v, want %+v", c.in, got, err, c.want)
		}
	}
	for _, bad := range []string{"etc", "p2:etc", "/etc/../root", "scsi0:"} {
		if _, err := parseGuestPath(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	all, _ := parseGuestPaths(nil)
	if len(all) != 1 || all[0].Path != "/" || all[0].Part != -1 {
		t.Fatalf("no paths → %+v", all)
	}
	sel := guestPathSel{Disk: "scsi0", Part: 2}
	if !sel.matches(pveGuestPartition{Disk: "scsi0", Index: 2}) || sel.matches(pveGuestPartition{Disk: "scsi1", Index: 2}) ||
		sel.matches(pveGuestPartition{Disk: "scsi0", Index: 1}) {
		t.Fatal("matches")
	}
}

func TestCopyGuestPaths(t *testing.T) {
	// copyGuestPaths copies a mounted Linux guest filesystem on a PVE host and
	// keeps POSIX modes and symlinks, which Windows can't represent (modes
	// read back as 0666, symlinks need a privilege).
	if runtime.GOOS == "windows" {
		t.Skip("Linux guest filesystems are only restored on a PVE (Linux) host")
	}
	src := t.TempDir()
	p1 := filepath.Join(src, "p1")
	p2 := filepath.Join(src, "p2")
	os.MkdirAll(filepath.Join(p1, "etc", "nginx"), 0o755)
	os.WriteFile(filepath.Join(p1, "etc", "nginx", "nginx.conf"), []byte("worker 1;"), 0o640)
	os.Symlink("nginx.conf", filepath.Join(p1, "etc", "nginx", "link"))
	os.MkdirAll(filepath.Join(p2, "etc"), 0o755)
	os.WriteFile(filepath.Join(p2, "etc", "fstab"), []byte("/dev/sda1 /"), 0o644)
	parts := []pveGuestPartition{{Disk: "scsi0", Index: 1, FSType: "ext4", Dir: p1}, {Disk: "scsi0", Index: 2, FSType: "xfs", Dir: p2}}

	target := t.TempDir()
	sels, _ := parseGuestPaths([]string{"/etc/nginx", "p2:/etc/fstab", "/missing"})
	st, used, err := copyGuestPaths(parts, sels, target, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	if st.Files != 3 || strings.Join(used, ",") != "scsi0-p1,scsi0-p2" {
		t.Fatalf("stats %+v used %v", st, used)
	}
	if b, _ := os.ReadFile(filepath.Join(target, "scsi0-p1", "etc", "nginx", "nginx.conf")); string(b) != "worker 1;" {
		t.Fatal("nginx.conf")
	}
	if fi, _ := os.Stat(filepath.Join(target, "scsi0-p1", "etc", "nginx", "nginx.conf")); fi.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v", fi.Mode())
	}
	if l, _ := os.Readlink(filepath.Join(target, "scsi0-p1", "etc", "nginx", "link")); l != "nginx.conf" {
		t.Fatal("symlink")
	}
	if _, err := os.Stat(filepath.Join(target, "scsi0-p2", "etc", "fstab")); err != nil {
		t.Fatal(err)
	}
	// Nothing matching is an error naming the filesystems.
	none, _ := parseGuestPaths([]string{"/nope"})
	if _, _, err := copyGuestPaths(parts, none, target, func(string) {}); err == nil || !strings.Contains(err.Error(), "scsi0-p2 (xfs)") {
		t.Fatalf("no match: %v", err)
	}
}

func TestLiveRestoreConfig(t *testing.T) {
	conf := strings.Join([]string{
		"name: web", "agent: 1", "bios: ovmf",
		"efidisk0: local-zfs:vm-100-disk-1,efitype=4m,size=1M",
		"scsi0: local-zfs:vm-100-disk-0,iothread=1,format=raw,size=40M",
		"scsi1: local-zfs:vm-100-disk-2,backup=0,size=1G",
		"ide2: local:iso/debian.iso,media=cdrom",
		"unused0: local-zfs:vm-100-disk-9",
		"net0: virtio=BC:24:11:00:00:01,bridge=vmbr0",
		"vmgenid: 11111111-2222-3333-4444-555555555555",
	}, "\n") + "\n"
	ov := map[string]string{"efidisk0": "nas:150/vm-150-amberlive-efidisk0.qcow2", "scsi0": "nas:150/vm-150-amberlive-scsi0.qcow2"}
	out, warns := liveRestoreConfig(conf, ov, "web-live", true)
	c := parsePveConfig(out)
	if c.Keys["scsi0"] != "nas:150/vm-150-amberlive-scsi0.qcow2,iothread=1,size=40M" {
		t.Fatalf("scsi0 %q", c.Keys["scsi0"])
	}
	if !strings.HasPrefix(c.Keys["efidisk0"], "nas:150/vm-150-amberlive-efidisk0.qcow2,efitype=4m") {
		t.Fatalf("efidisk0 %q", c.Keys["efidisk0"])
	}
	if _, ok := c.Keys["scsi1"]; ok || len(warns) != 1 || !strings.Contains(warns[0], "scsi1") {
		t.Fatalf("scsi1 kept? %v %v", c.Keys["scsi1"], warns)
	}
	if _, ok := c.Keys["unused0"]; ok {
		t.Fatal("unused0 kept")
	}
	if c.Keys["ide2"] != "local:iso/debian.iso,media=cdrom" || c.Keys["name"] != "web-live" {
		t.Fatalf("ide2/name %v", c.Keys)
	}
	if strings.Contains(c.Keys["net0"], "00:00:01") || !strings.HasPrefix(c.Keys["net0"], "virtio=BC:24:11:") || !strings.HasSuffix(c.Keys["net0"], ",bridge=vmbr0") {
		t.Fatalf("net0 %q", c.Keys["net0"])
	}
	if c.Keys["vmgenid"] == "11111111-2222-3333-4444-555555555555" || len(c.Keys["vmgenid"]) != 36 {
		t.Fatalf("vmgenid %q", c.Keys["vmgenid"])
	}
	// Without unique the MAC stays.
	out, _ = liveRestoreConfig(conf, ov, "", false)
	if c := parsePveConfig(out); c.Keys["net0"] != "virtio=BC:24:11:00:00:01,bridge=vmbr0" || c.Keys["name"] != "web" {
		t.Fatalf("not unique: %v", c.Keys)
	}
}

func TestParseTransferred(t *testing.T) {
	d, tot, ok := parseTransferred("drive-scsi0: transferred 1.5 GiB of 32.0 GiB (4.69%) in 12s")
	if !ok || d != 3<<29 || tot != 32<<30 {
		t.Fatalf("%d %d %v", d, tot, ok)
	}
	if _, _, ok := parseTransferred("drive mirror is starting"); ok {
		t.Fatal("matched")
	}
}
