package main

import (
	"archive/tar"
	"bytes"
	"io"
	"math/rand"
	"strings"
	"testing"
)

func TestVMARoundTrip(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	disk1 := make([]byte, 5*vmaClusterSize+1234) // partial last cluster
	r.Read(disk1)
	clear(disk1[vmaClusterSize : 2*vmaClusterSize])          // a zero cluster
	clear(disk1[3*vmaClusterSize : 3*vmaClusterSize+3*4096]) // zero blocks
	disk2 := make([]byte, 70*vmaClusterSize)                 // more than one extent
	r.Read(disk2[:10*vmaClusterSize])
	conf := []byte("#qmdump#map:scsi0:drive-scsi0:local-lvm:raw:\nname: t\n")

	var buf bytes.Buffer
	vw, err := newVMAWriter(&buf, []vmaConfig{{Name: "qemu-server.conf", Data: conf}},
		[]vmaDevice{{Name: "drive-scsi0", Size: int64(len(disk1))}, {Name: "drive-efidisk0", Size: int64(len(disk2))}})
	if err != nil {
		t.Fatal(err)
	}
	// Device 1 in odd-sized writes, device 2 sequential.
	for off := 0; off < len(disk1); off += 7777 {
		end := off + 7777
		if end > len(disk1) {
			end = len(disk1)
		}
		if _, err := vw.Device(1).Write(disk1[off:end]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := vw.Device(2).Write(disk2); err != nil {
		t.Fatal(err)
	}
	if err := vw.Close(); err != nil {
		t.Fatal(err)
	}
	if buf.Len() >= len(disk1)+len(disk2) {
		t.Fatalf("zero data was not skipped: %d bytes", buf.Len())
	}

	out := map[int][]byte{}
	arch, err := readVMA(bytes.NewReader(buf.Bytes()), func(dev int, cluster uint32, data []byte) error {
		b := out[dev]
		end := int(cluster+1) * vmaClusterSize
		for len(b) < end {
			b = append(b, make([]byte, vmaClusterSize)...)
		}
		copy(b[int(cluster)*vmaClusterSize:], data)
		out[dev] = b
		return nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(arch.Configs["qemu-server.conf"]) != string(conf) {
		t.Fatalf("config %q", arch.Configs["qemu-server.conf"])
	}
	if arch.Devices[1].Name != "drive-scsi0" || arch.Devices[2].Size != int64(len(disk2)) {
		t.Fatalf("devices %+v", arch.Devices)
	}
	if !bytes.Equal(out[1][:len(disk1)], disk1) || !bytes.Equal(out[2][:len(disk2)], disk2) {
		t.Fatal("device data differs")
	}

	// A flipped byte in the header or an extent is detected.
	for _, pos := range []int{100, vmaHeaderSize + 600} {
		bad := append([]byte(nil), buf.Bytes()...)
		bad[pos] ^= 0xff
		if _, err := readVMA(bytes.NewReader(bad), nil, nil); err == nil {
			t.Fatalf("corruption at %d not detected", pos)
		}
	}
	// A truncated archive misses clusters.
	if _, err := readVMA(bytes.NewReader(buf.Bytes()[:buf.Len()-vmaExtHeaderSize-4096]), nil, nil); err == nil {
		t.Fatal("truncated archive accepted")
	}
}

func TestVMAWriterRejectsOverflow(t *testing.T) {
	vw, err := newVMAWriter(io.Discard, nil, []vmaDevice{{Name: "drive-scsi0", Size: 10}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := vw.Device(1).Write(make([]byte, 11)); err == nil {
		t.Fatal("more data than the device size accepted")
	}
}

func TestRewriteCTArchive(t *testing.T) {
	var src bytes.Buffer
	tw := tar.NewWriter(&src)
	add := func(h *tar.Header, body string) {
		h.Size = int64(len(body))
		if h.Typeflag == tar.TypeDir || h.Typeflag == tar.TypeLink || h.Typeflag == tar.TypeSymlink {
			h.Size = 0
		}
		tw.WriteHeader(h)
		if h.Size > 0 {
			tw.Write([]byte(body))
		}
	}
	p := "run/amber-agent/pve/101/root"
	add(&tar.Header{Typeflag: tar.TypeDir, Name: "run/amber-agent/pve/101/", Mode: 0o755}, "")
	add(&tar.Header{Typeflag: tar.TypeDir, Name: p + "/", Mode: 0o755, Uid: 100000, Gid: 100000}, "")
	add(&tar.Header{Typeflag: tar.TypeReg, Name: p + "/etc/hostname", Mode: 0o644, Uid: 100000, Gid: 100000}, "ct\n")
	add(&tar.Header{Typeflag: tar.TypeReg, Name: p + "/home/u/f", Mode: 0o600, Uid: 101000, Gid: 101000}, "x")
	add(&tar.Header{Typeflag: tar.TypeLink, Name: p + "/home/u/g", Linkname: p + "/home/u/f"}, "")
	add(&tar.Header{Typeflag: tar.TypeSymlink, Name: p + "/bin", Linkname: "usr/bin"}, "")
	add(&tar.Header{Typeflag: tar.TypeReg, Name: "run/amber-agent/pve/101/manifest.json", Mode: 0o600}, "{}")
	tw.Close()

	var dst bytes.Buffer
	if err := rewriteCTArchive(&dst, &src, "/"+p, []byte("hostname: ct\n"), defaultIDMap); err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(&dst)
	var names []string
	got := map[string]*tar.Header{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, h.Name)
		got[h.Name] = h
		if h.Name == "./etc/vzdump/pct.conf" {
			b, _ := io.ReadAll(tr)
			if string(b) != "hostname: ct\n" {
				t.Fatalf("pct.conf %q", b)
			}
		}
	}
	if names[2] != "./etc/vzdump/pct.conf" {
		t.Fatalf("pct.conf must come first: %v", names)
	}
	for _, n := range []string{"./", "./etc/hostname", "./home/u/f", "./home/u/g", "./bin"} {
		if got[n] == nil {
			t.Fatalf("missing %s in %v", n, names)
		}
	}
	if strings.Contains(strings.Join(names, " "), "manifest") {
		t.Fatal("files outside the root leaked")
	}
	if got["./home/u/f"].Uid != 1000 || got["./etc/hostname"].Gid != 0 {
		t.Fatalf("ids not shifted: %d %d", got["./home/u/f"].Uid, got["./etc/hostname"].Gid)
	}
	if got["./home/u/g"].Linkname != "./home/u/f" || got["./bin"].Linkname != "usr/bin" {
		t.Fatalf("links: %q %q", got["./home/u/g"].Linkname, got["./bin"].Linkname)
	}
}
