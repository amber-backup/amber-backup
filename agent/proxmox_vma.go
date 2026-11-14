package main

// VMA — the archive format of Proxmox's vzdump for VMs — written as a stream
// (restores of block snapshots go through `qmrestore -`) and read back (tests,
// mock). Layout after pve-qemu's vma_spec.txt / vma.h:
//
//	header (VmaHeader, 12288 bytes + blob buffer), big endian:
//	  magic "VMA\0", version 1, uuid[16], ctime int64, md5sum[16] (of the
//	  header with md5sum zeroed), blob_buffer_offset, blob_buffer_size,
//	  header_size, reserved[1984], config_names[256], config_data[256],
//	  reserved[4], dev_info[256] × {reserved u64, size u64, reserved[8],
//	  devname_ptr u32, reserved[4]}
//	blob buffer: entries of u16 length (little endian!) + data, starting at
//	  offset 1 (0 = none), grown in 512-byte steps
//	extents: 512-byte header {magic "VMAE", reserved u16, block_count u16,
//	  uuid[16], md5sum[16] (of the header), blockinfo[59] u64} followed by the
//	  non-zero 4 KiB blocks of up to 59 clusters (64 KiB). blockinfo =
//	  mask(16) << 48 | dev_id(8) << 32 | cluster_num(32); mask bit i = block i
//	  is present; a zero cluster has mask 0 and no data.
//
// ASSUMPTION(pve): this matches what `vma extract`/qmrestore accept,
// including every cluster of every device having to appear once.

import (
	"bytes"
	"crypto/md5"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"time"
)

const (
	vmaBlockSize      = 4096
	vmaClusterSize    = 65536
	vmaBlocksPerExt   = 59
	vmaExtHeaderSize  = 512
	vmaHeaderSize     = 12288
	vmaMaxConfigs     = 256
	vmaMaxDevices     = 256
	vmaHeaderMD5Off   = 32
	vmaExtMD5Off      = 24
	vmaMaxHeaderBytes = 2 << 20
)

type vmaDevice struct {
	Name string
	Size int64
}

type vmaConfig struct {
	Name string
	Data []byte
}

type vmaWriter struct {
	w       io.Writer
	uuid    [16]byte
	devs    []vmaDevice // index 0 = device id 1
	info    [vmaBlocksPerExt]uint64
	count   int
	data    bytes.Buffer
	pending map[int]*vmaDevStream
	closed  bool
}

// newVMAWriter writes the header; clusters follow via WriteCluster or the
// per-device sequential writers.
func newVMAWriter(w io.Writer, configs []vmaConfig, devs []vmaDevice) (*vmaWriter, error) {
	if len(devs) == 0 || len(devs) > 254 {
		return nil, fmt.Errorf("VMA needs 1–254 devices, got %d", len(devs))
	}
	if len(configs) > vmaMaxConfigs {
		return nil, errors.New("too many VMA config blobs")
	}
	v := &vmaWriter{w: w, devs: devs, pending: map[int]*vmaDevStream{}}
	rand.Read(v.uuid[:])

	blob := []byte{0} // position 0 means "none"
	addBlob := func(data []byte) (uint32, error) {
		if len(data) > 65535 {
			return 0, errors.New("VMA blob larger than 64 KiB")
		}
		pos := uint32(len(blob))
		blob = append(blob, byte(len(data)), byte(len(data)>>8))
		blob = append(blob, data...)
		return pos, nil
	}
	head := make([]byte, vmaHeaderSize)
	copy(head[0:4], "VMA\x00")
	binary.BigEndian.PutUint32(head[4:], 1)
	copy(head[8:24], v.uuid[:])
	binary.BigEndian.PutUint64(head[24:], uint64(time.Now().Unix()))
	const namesOff = 60 + 1984
	const dataOff = namesOff + 4*vmaMaxConfigs
	const devOff = dataOff + 4*vmaMaxConfigs + 4
	for i, c := range configs {
		np, err := addBlob(append([]byte(c.Name), 0))
		if err != nil {
			return nil, err
		}
		dp, err := addBlob(c.Data)
		if err != nil {
			return nil, err
		}
		binary.BigEndian.PutUint32(head[namesOff+4*i:], np)
		binary.BigEndian.PutUint32(head[dataOff+4*i:], dp)
	}
	for i, d := range devs {
		np, err := addBlob(append([]byte(d.Name), 0))
		if err != nil {
			return nil, err
		}
		o := devOff + 32*(i+1) // device ids start at 1
		binary.BigEndian.PutUint64(head[o+8:], uint64(d.Size))
		binary.BigEndian.PutUint32(head[o+24:], np)
	}
	// The blob buffer grows in 512-byte steps.
	if pad := (512 - len(blob)%512) % 512; pad > 0 {
		blob = append(blob, make([]byte, pad)...)
	}
	binary.BigEndian.PutUint32(head[48:], vmaHeaderSize)
	binary.BigEndian.PutUint32(head[52:], uint32(len(blob)))
	binary.BigEndian.PutUint32(head[56:], uint32(vmaHeaderSize+len(blob)))
	full := append(head, blob...)
	sum := md5.Sum(full)
	copy(full[vmaHeaderMD5Off:], sum[:])
	if _, err := w.Write(full); err != nil {
		return nil, err
	}
	return v, nil
}

func isZero(b []byte) bool {
	for _, c := range b {
		if c != 0 {
			return false
		}
	}
	return true
}

// WriteCluster adds one 64 KiB cluster of device devID (1-based); data
// shorter than a cluster is zero-padded.
func (v *vmaWriter) WriteCluster(devID int, cluster uint32, data []byte) error {
	if devID < 1 || devID > len(v.devs) {
		return fmt.Errorf("bad VMA device id %d", devID)
	}
	var mask uint64
	for i := 0; i < 16; i++ {
		lo := i * vmaBlockSize
		if lo >= len(data) {
			break
		}
		hi := lo + vmaBlockSize
		var block []byte
		if hi <= len(data) {
			block = data[lo:hi]
		} else {
			block = make([]byte, vmaBlockSize)
			copy(block, data[lo:])
		}
		if isZero(block) {
			continue
		}
		mask |= 1 << i
		v.data.Write(block)
	}
	v.info[v.count] = mask<<48 | uint64(devID)<<32 | uint64(cluster)
	v.count++
	if v.count == vmaBlocksPerExt {
		return v.flush()
	}
	return nil
}

func (v *vmaWriter) flush() error {
	if v.count == 0 {
		return nil
	}
	h := make([]byte, vmaExtHeaderSize)
	copy(h[0:4], "VMAE")
	binary.BigEndian.PutUint16(h[6:], uint16(v.data.Len()/vmaBlockSize))
	copy(h[8:24], v.uuid[:])
	for i := 0; i < vmaBlocksPerExt; i++ {
		binary.BigEndian.PutUint64(h[40+8*i:], v.info[i])
	}
	sum := md5.Sum(h)
	copy(h[vmaExtMD5Off:], sum[:])
	if _, err := v.w.Write(h); err != nil {
		return err
	}
	if _, err := v.w.Write(v.data.Bytes()); err != nil {
		return err
	}
	v.data.Reset()
	v.count = 0
	v.info = [vmaBlocksPerExt]uint64{}
	return nil
}

// vmaDevStream turns a device's bytes, written in order, into clusters.
type vmaDevStream struct {
	v       *vmaWriter
	id      int
	buf     []byte
	cluster uint32
	written int64
}

// Device returns the sequential writer of device devID (1-based).
func (v *vmaWriter) Device(devID int) *vmaDevStream {
	if s := v.pending[devID]; s != nil {
		return s
	}
	s := &vmaDevStream{v: v, id: devID, buf: make([]byte, 0, vmaClusterSize)}
	v.pending[devID] = s
	return s
}

func (s *vmaDevStream) Write(p []byte) (int, error) {
	size := s.v.devs[s.id-1].Size
	if s.written+int64(len(p)) > size {
		return 0, fmt.Errorf("device %s: more data than its size %d", s.v.devs[s.id-1].Name, size)
	}
	n := len(p)
	for len(p) > 0 {
		take := vmaClusterSize - len(s.buf)
		if take > len(p) {
			take = len(p)
		}
		s.buf = append(s.buf, p[:take]...)
		p = p[take:]
		if len(s.buf) == vmaClusterSize {
			if err := s.v.WriteCluster(s.id, s.cluster, s.buf); err != nil {
				return 0, err
			}
			s.cluster++
			s.buf = s.buf[:0]
		}
	}
	s.written += int64(n)
	return n, nil
}

// finish pads the device with zero clusters up to its size.
func (s *vmaDevStream) finish() error {
	size := s.v.devs[s.id-1].Size
	clusters := uint32((size + vmaClusterSize - 1) / vmaClusterSize)
	if len(s.buf) > 0 {
		if err := s.v.WriteCluster(s.id, s.cluster, s.buf); err != nil {
			return err
		}
		s.cluster++
		s.buf = s.buf[:0]
	}
	for ; s.cluster < clusters; s.cluster++ {
		if err := s.v.WriteCluster(s.id, s.cluster, nil); err != nil {
			return err
		}
	}
	return nil
}

// Close finishes every device that was written sequentially (and any never
// touched, as zeros) and flushes the last extent.
func (v *vmaWriter) Close() error {
	if v.closed {
		return nil
	}
	v.closed = true
	for id := 1; id <= len(v.devs); id++ {
		if err := v.Device(id).finish(); err != nil {
			return err
		}
	}
	return v.flush()
}

// --- Reader -------------------------------------------------------------------

type vmaArchive struct {
	Configs map[string][]byte
	// Devices by id (1-based); unused ids are absent.
	Devices map[int]vmaDevice
}

// readVMA parses a VMA stream, verifying checksums, and calls onCluster for
// every cluster (data is 64 KiB, zero-filled where blocks are absent).
func readVMA(r io.Reader, onCluster func(devID int, cluster uint32, data []byte) error, onHeader func(*vmaArchive) error) (*vmaArchive, error) {
	head := make([]byte, vmaHeaderSize)
	if _, err := io.ReadFull(r, head); err != nil {
		return nil, fmt.Errorf("VMA header: %w", err)
	}
	if string(head[0:4]) != "VMA\x00" || binary.BigEndian.Uint32(head[4:]) != 1 {
		return nil, errors.New("not a VMA v1 archive")
	}
	var uuid [16]byte
	copy(uuid[:], head[8:24])
	blobOff := binary.BigEndian.Uint32(head[48:])
	blobSize := binary.BigEndian.Uint32(head[52:])
	headerSize := binary.BigEndian.Uint32(head[56:])
	if blobOff != vmaHeaderSize || headerSize != blobOff+blobSize || headerSize > vmaMaxHeaderBytes {
		return nil, errors.New("VMA header: bad sizes")
	}
	full := make([]byte, headerSize)
	copy(full, head)
	if _, err := io.ReadFull(r, full[vmaHeaderSize:]); err != nil {
		return nil, fmt.Errorf("VMA blob buffer: %w", err)
	}
	var want [16]byte
	copy(want[:], full[vmaHeaderMD5Off:])
	clear(full[vmaHeaderMD5Off : vmaHeaderMD5Off+16])
	if md5.Sum(full) != want {
		return nil, errors.New("VMA header checksum mismatch")
	}
	blob := full[vmaHeaderSize:]
	getBlob := func(pos uint32) ([]byte, error) {
		if pos == 0 || int(pos)+2 > len(blob) {
			return nil, errors.New("bad blob pointer")
		}
		l := int(blob[pos]) | int(blob[pos+1])<<8
		if int(pos)+2+l > len(blob) {
			return nil, errors.New("blob past the buffer")
		}
		return blob[pos+2 : int(pos)+2+l], nil
	}
	cstr := func(b []byte) string { return string(bytes.TrimRight(b, "\x00")) }
	arch := &vmaArchive{Configs: map[string][]byte{}, Devices: map[int]vmaDevice{}}
	const namesOff = 60 + 1984
	const dataOff = namesOff + 4*vmaMaxConfigs
	const devOff = dataOff + 4*vmaMaxConfigs + 4
	for i := 0; i < vmaMaxConfigs; i++ {
		np := binary.BigEndian.Uint32(full[namesOff+4*i:])
		dp := binary.BigEndian.Uint32(full[dataOff+4*i:])
		if np == 0 {
			continue
		}
		name, err := getBlob(np)
		if err != nil {
			return nil, err
		}
		data, err := getBlob(dp)
		if err != nil {
			return nil, err
		}
		arch.Configs[cstr(name)] = append([]byte(nil), data...)
	}
	for i := 1; i < vmaMaxDevices; i++ {
		o := devOff + 32*i
		size := int64(binary.BigEndian.Uint64(full[o+8:]))
		np := binary.BigEndian.Uint32(full[o+24:])
		if size == 0 || np == 0 {
			continue
		}
		name, err := getBlob(np)
		if err != nil {
			return nil, err
		}
		arch.Devices[i] = vmaDevice{Name: cstr(name), Size: size}
	}

	if onHeader != nil {
		if err := onHeader(arch); err != nil {
			return nil, err
		}
	}
	seen := map[int]map[uint32]bool{}
	ext := make([]byte, vmaExtHeaderSize)
	cluster := make([]byte, vmaClusterSize)
	for {
		if _, err := io.ReadFull(r, ext); err != nil {
			if err == io.EOF {
				break
			}
			return nil, fmt.Errorf("VMA extent: %w", err)
		}
		if string(ext[0:4]) != "VMAE" {
			return nil, errors.New("bad VMA extent magic")
		}
		var sum [16]byte
		copy(sum[:], ext[vmaExtMD5Off:])
		clear(ext[vmaExtMD5Off : vmaExtMD5Off+16])
		if md5.Sum(ext) != sum {
			return nil, errors.New("VMA extent checksum mismatch")
		}
		if !bytes.Equal(ext[8:24], uuid[:]) {
			return nil, errors.New("VMA extent of another archive")
		}
		blocks := int(binary.BigEndian.Uint16(ext[6:]))
		data := make([]byte, blocks*vmaBlockSize)
		if _, err := io.ReadFull(r, data); err != nil {
			return nil, fmt.Errorf("VMA extent data: %w", err)
		}
		pos := 0
		for i := 0; i < vmaBlocksPerExt; i++ {
			bi := binary.BigEndian.Uint64(ext[40+8*i:])
			dev := int(bi >> 32 & 0xff)
			if dev == 0 {
				continue
			}
			if _, ok := arch.Devices[dev]; !ok {
				return nil, fmt.Errorf("VMA extent references unknown device %d", dev)
			}
			num := uint32(bi)
			mask := uint16(bi >> 48)
			clear(cluster)
			for b := 0; b < 16; b++ {
				if mask&(1<<b) == 0 {
					continue
				}
				if pos+vmaBlockSize > len(data) {
					return nil, errors.New("VMA extent: block count too small")
				}
				copy(cluster[b*vmaBlockSize:], data[pos:pos+vmaBlockSize])
				pos += vmaBlockSize
			}
			if seen[dev] == nil {
				seen[dev] = map[uint32]bool{}
			}
			seen[dev][num] = true
			if onCluster != nil {
				if err := onCluster(dev, num, cluster); err != nil {
					return nil, err
				}
			}
		}
		if pos != len(data) {
			return nil, errors.New("VMA extent: block count mismatch")
		}
	}
	for id, d := range arch.Devices {
		need := uint32((d.Size + vmaClusterSize - 1) / vmaClusterSize)
		if uint32(len(seen[id])) != need {
			return nil, fmt.Errorf("VMA device %s: %d of %d clusters present", d.Name, len(seen[id]), need)
		}
	}
	return arch, nil
}
