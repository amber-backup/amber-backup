package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

// listenUnix listens on a unix socket in a fresh temp dir. The NBD and QMP
// clients are portable code, so they are tested on Windows too, which has
// AF_UNIX since Windows 10 1803; a Windows without it (or Wine) skips.
func listenUnix(t *testing.T, name string) (net.Listener, string) {
	t.Helper()
	sock := filepath.Join(t.TempDir(), name)
	ln, err := net.Listen("unix", sock)
	// WSAEAFNOSUPPORT: this Windows has no AF_UNIX.
	if err != nil && runtime.GOOS == "windows" && errors.Is(err, syscall.Errno(10047)) {
		t.Skipf("no AF_UNIX support: %v", err)
	}
	if err != nil {
		t.Fatal(err)
	}
	return ln, sock
}

// fakeNBD serves one export over the fixed newstyle protocol with structured
// replies: data for reads, dirty extents for the meta context.
type fakeNBD struct {
	name, ctxName string
	data          []byte
	dirty         []pveExtent
}

func (f *fakeNBD) serve(t *testing.T, ln net.Listener) {
	conn, err := ln.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	r := bufio.NewReader(conn)
	w := conn
	be := binary.BigEndian
	put := func(vals ...any) {
		for _, v := range vals {
			binary.Write(w, be, v)
		}
	}
	put(uint64(nbdMagic), uint64(nbdIHaveOpt), uint16(nbdFlagFixedNewstyle|nbdFlagNoZeroes))
	var cflags uint32
	binary.Read(r, be, &cflags)
	reply := func(opt, typ uint32, data []byte) {
		put(uint64(nbdOptReplyMagic), opt, typ, uint32(len(data)))
		w.Write(data)
	}
	const ctxID = 7
	for {
		var magic uint64
		var opt, l uint32
		if binary.Read(r, be, &magic) != nil {
			return
		}
		binary.Read(r, be, &opt)
		binary.Read(r, be, &l)
		payload := make([]byte, l)
		io.ReadFull(r, payload)
		switch opt {
		case nbdOptStructuredReply:
			reply(opt, nbdRepAck, nil)
		case nbdOptSetMetaContext:
			if strings.Contains(string(payload), f.ctxName) {
				d := be.AppendUint32(nil, ctxID)
				reply(opt, nbdRepMetaContext, append(d, f.ctxName...))
			}
			reply(opt, nbdRepAck, nil)
		case nbdOptGo:
			n := be.Uint32(payload)
			if string(payload[4:4+n]) != f.name {
				reply(opt, nbdRepFlagError|6, []byte("no such export"))
				continue
			}
			info := be.AppendUint16(nil, nbdInfoExport)
			info = be.AppendUint64(info, uint64(len(f.data)))
			info = be.AppendUint16(info, 0)
			reply(opt, nbdRepInfo, info)
			reply(opt, nbdRepAck, nil)
			goto transmission
		}
	}
transmission:
	for {
		var magic uint32
		var flags, cmd uint16
		var cookie, off uint64
		var length uint32
		if binary.Read(r, be, &magic) != nil {
			return
		}
		binary.Read(r, be, &flags)
		binary.Read(r, be, &cmd)
		binary.Read(r, be, &cookie)
		binary.Read(r, be, &off)
		binary.Read(r, be, &length)
		chunk := func(fl, typ uint16, p []byte) {
			put(uint32(nbdStructReplyMagic), fl, typ, cookie, uint32(len(p)))
			w.Write(p)
		}
		switch cmd {
		case nbdCmdDisc:
			return
		case nbdCmdRead:
			// Two chunks: data for the first half, a hole for the rest when it is zero.
			half := uint64(length / 2)
			d1 := be.AppendUint64(nil, off)
			chunk(0, nbdReplyTypeOffsetData, append(d1, f.data[off:off+half]...))
			d2 := be.AppendUint64(nil, off+half)
			chunk(nbdReplyFlagDone, nbdReplyTypeOffsetData, append(d2, f.data[off+half:off+uint64(length)]...))
		case nbdCmdBlockStatus:
			// Describe [off, off+length) in at most 3 descriptors (forces looping).
			p := be.AppendUint32(nil, ctxID)
			pos, end := int64(off), int64(off)+int64(length)
			for i := 0; i < 3 && pos < end; i++ {
				st, l := uint32(0), end-pos
				for _, e := range f.dirty {
					if pos >= e.Offset && pos < e.Offset+e.Length {
						st, l = 1, min(l, e.Offset+e.Length-pos)
					} else if e.Offset > pos {
						l = min(l, e.Offset-pos)
					}
				}
				p = be.AppendUint32(p, uint32(l))
				p = be.AppendUint32(p, st)
				pos += l
			}
			chunk(nbdReplyFlagDone, nbdReplyTypeBlockStatus, p)
		}
	}
}

func TestNBDClient(t *testing.T) {
	ln, sock := listenUnix(t, "nbd.sock")
	defer ln.Close()
	data := make([]byte, 1<<20)
	for i := range data {
		data[i] = byte(i * 7)
	}
	f := &fakeNBD{name: "exp", ctxName: "qemu:dirty-bitmap:bm", data: data,
		dirty: []pveExtent{{Offset: 4096, Length: 8192}, {Offset: 65536, Length: 65536}, {Offset: 900000, Length: 100}}}
	go f.serve(t, ln)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := nbdConnect(ctx, sock, "exp", "qemu:dirty-bitmap:bm")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if c.Size() != int64(len(data)) {
		t.Fatalf("size %d", c.Size())
	}
	ext, err := c.DirtyExtents()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ext, f.dirty) {
		t.Fatalf("extents %v, want %v", ext, f.dirty)
	}
	buf := make([]byte, 10000)
	if n, err := c.ReadAt(buf, 5000); err != nil || n != len(buf) {
		t.Fatalf("read n=%d err=%v", n, err)
	}
	for i, b := range buf {
		if b != data[5000+i] {
			t.Fatalf("byte %d differs", i)
		}
	}
	if n, err := c.ReadAt(buf, int64(len(data))-100); n != 100 || err != io.EOF {
		t.Fatalf("read at the end: n=%d err=%v", n, err)
	}
}

func TestNBDUnknownMetaContext(t *testing.T) {
	ln, sock := listenUnix(t, "nbd.sock")
	defer ln.Close()
	go (&fakeNBD{name: "exp", ctxName: "qemu:dirty-bitmap:other", data: make([]byte, 4096)}).serve(t, ln)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := nbdConnect(ctx, sock, "exp", "qemu:dirty-bitmap:bm"); err == nil {
		t.Fatal("missing meta context accepted")
	}
}

func TestQMPClient(t *testing.T) {
	ln, sock := listenUnix(t, "qmp.sock")
	defer ln.Close()
	var seen []string
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		conn.Write([]byte(`{"QMP": {"version": {}, "capabilities": []}}` + "\n"))
		sc := bufio.NewScanner(conn)
		for sc.Scan() {
			var req struct {
				Execute string `json:"execute"`
				ID      string `json:"id"`
			}
			json.Unmarshal(sc.Bytes(), &req)
			seen = append(seen, req.Execute)
			switch req.Execute {
			case "query-block":
				conn.Write([]byte(`{"event":"SOMETHING","data":{}}` + "\n"))
				conn.Write([]byte(`{"return":[{"device":"drive-scsi0","qdev":"scsi0","inserted":{"node-name":"#block123","dirty-bitmaps":[{"name":"amber-x"}]}},{"device":"drive-ide2","qdev":"ide2"},{"device":"","qdev":"/machine/peripheral/virtio1/virtio-backend","inserted":{"node-name":"drive-virtio1"}}],"id":"` + req.ID + `"}` + "\n"))
			case "fail":
				conn.Write([]byte(`{"error":{"class":"GenericError","desc":"nope"},"id":"` + req.ID + `"}` + "\n"))
			default:
				conn.Write([]byte(`{"return":{},"id":"` + req.ID + `"}` + "\n"))
			}
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := qmpDial(ctx, sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var blocks []qmpBlockInfo
	if err := c.Execute("query-block", nil, &blocks); err != nil {
		t.Fatal(err)
	}
	node, b, err := qmpNodeFor(blocks, "scsi0")
	if err != nil || node != "#block123" || !b.hasBitmap("amber-x") || b.hasBitmap("other") {
		t.Fatalf("scsi0: %s %v", node, err)
	}
	if node, _, err := qmpNodeFor(blocks, "virtio1"); err != nil || node != "drive-virtio1" {
		t.Fatalf("blockdev-style node: %s %v", node, err)
	}
	if _, _, err := qmpNodeFor(blocks, "ide2"); err == nil {
		t.Fatal("a drive without medium has no node")
	}
	err = c.Execute("fail", nil, nil)
	if qe, ok := err.(*qmpError); !ok || qe.Desc != "nope" {
		t.Fatalf("error %v", err)
	}
	if seen[0] != "qmp_capabilities" {
		t.Fatalf("capabilities not negotiated first: %v", seen)
	}
}
