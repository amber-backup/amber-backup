package main

// A minimal NBD client (fixed newstyle handshake, structured replies): reads
// block status for a meta context — the block method asks QEMU for
// qemu:dirty-bitmap:<name> on a temporary export — and plain reads (used for
// qcow2 snapshots served by qemu-nbd).

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

const (
	nbdMagic            = 0x4e42444d41474943 // "NBDMAGIC"
	nbdIHaveOpt         = 0x49484156454f5054 // "IHAVEOPT"
	nbdOptReplyMagic    = 0x3e889045565a9
	nbdRequestMagic     = 0x25609513
	nbdSimpleReplyMagic = 0x67446698
	nbdStructReplyMagic = 0x668e33ef

	nbdFlagFixedNewstyle = 1 << 0
	nbdFlagNoZeroes      = 1 << 1
	nbdFlagCFixed        = 1 << 0
	nbdFlagCNoZeroes     = 1 << 1

	nbdOptAbort           = 2
	nbdOptGo              = 7
	nbdOptStructuredReply = 8
	nbdOptSetMetaContext  = 10

	nbdRepAck         = 1
	nbdRepInfo        = 3
	nbdRepMetaContext = 4
	nbdRepFlagError   = 1 << 31

	nbdInfoExport = 0

	nbdCmdRead        = 0
	nbdCmdDisc        = 2
	nbdCmdBlockStatus = 7

	nbdReplyFlagDone        = 1 << 0
	nbdReplyTypeNone        = 0
	nbdReplyTypeOffsetData  = 1
	nbdReplyTypeOffsetHole  = 2
	nbdReplyTypeBlockStatus = 5
	nbdReplyTypeErrorBit    = 1 << 15

	// qemu:dirty-bitmap:<name>: status bit 0 = dirty.
	nbdStateDirty = 1
)

type nbdClient struct {
	conn      net.Conn
	r         *bufio.Reader
	w         *bufio.Writer
	size      int64
	contextID uint32
	hasCtx    bool
	mu        sync.Mutex
	cookie    uint64
}

// nbdConnect opens export name on the unix socket; metaContext (optional) is
// negotiated for block status.
func nbdConnect(ctx context.Context, socket, name, metaContext string) (*nbdClient, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, err
	}
	c := &nbdClient{conn: conn, r: bufio.NewReaderSize(conn, 1<<20), w: bufio.NewWriter(conn)}
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
	}
	if err := c.handshake(name, metaContext); err != nil {
		conn.Close()
		return nil, err
	}
	conn.SetDeadline(time.Time{})
	return c, nil
}

func (c *nbdClient) be32(v uint32) { binary.Write(c.w, binary.BigEndian, v) }
func (c *nbdClient) be64(v uint64) { binary.Write(c.w, binary.BigEndian, v) }
func (c *nbdClient) be16(v uint16) { binary.Write(c.w, binary.BigEndian, v) }

func (c *nbdClient) read(v any) error { return binary.Read(c.r, binary.BigEndian, v) }

func (c *nbdClient) handshake(name, metaContext string) error {
	var magic, opt uint64
	var flags uint16
	if err := c.read(&magic); err != nil {
		return fmt.Errorf("NBD handshake: %w", err)
	}
	if err := c.read(&opt); err != nil {
		return err
	}
	if magic != nbdMagic || opt != nbdIHaveOpt {
		return errors.New("NBD handshake: not a newstyle server")
	}
	if err := c.read(&flags); err != nil {
		return err
	}
	if flags&nbdFlagFixedNewstyle == 0 {
		return errors.New("NBD handshake: server lacks fixed newstyle")
	}
	cflags := uint32(nbdFlagCFixed)
	if flags&nbdFlagNoZeroes != 0 {
		cflags |= nbdFlagCNoZeroes
	}
	c.be32(cflags)

	// Structured replies (needed for block status).
	c.sendOpt(nbdOptStructuredReply, nil)
	if _, err := c.optReplies(nbdOptStructuredReply, nil); err != nil {
		return fmt.Errorf("NBD structured replies: %w", err)
	}

	if metaContext != "" {
		var data []byte
		data = binary.BigEndian.AppendUint32(data, uint32(len(name)))
		data = append(data, name...)
		data = binary.BigEndian.AppendUint32(data, 1)
		data = binary.BigEndian.AppendUint32(data, uint32(len(metaContext)))
		data = append(data, metaContext...)
		c.sendOpt(nbdOptSetMetaContext, data)
		_, err := c.optReplies(nbdOptSetMetaContext, func(typ uint32, payload []byte) error {
			if typ == nbdRepMetaContext && len(payload) >= 4 {
				if string(payload[4:]) == metaContext {
					c.contextID = binary.BigEndian.Uint32(payload)
					c.hasCtx = true
				}
			}
			return nil
		})
		if err != nil {
			return fmt.Errorf("NBD meta context: %w", err)
		}
		if !c.hasCtx {
			return fmt.Errorf("NBD server does not offer %s", metaContext)
		}
	}

	var data []byte
	data = binary.BigEndian.AppendUint32(data, uint32(len(name)))
	data = append(data, name...)
	data = binary.BigEndian.AppendUint16(data, 0) // no extra info requests
	c.sendOpt(nbdOptGo, data)
	gotSize := false
	_, err := c.optReplies(nbdOptGo, func(typ uint32, payload []byte) error {
		if typ == nbdRepInfo && len(payload) >= 12 && binary.BigEndian.Uint16(payload) == nbdInfoExport {
			c.size = int64(binary.BigEndian.Uint64(payload[2:]))
			gotSize = true
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("NBD export %q: %w", name, err)
	}
	if !gotSize {
		return errors.New("NBD server sent no export size")
	}
	return nil
}

func (c *nbdClient) sendOpt(opt uint32, data []byte) {
	c.be64(nbdIHaveOpt)
	c.be32(opt)
	c.be32(uint32(len(data)))
	c.w.Write(data)
	c.w.Flush()
}

// optReplies reads option replies until ACK, passing the others to fn.
func (c *nbdClient) optReplies(opt uint32, fn func(typ uint32, payload []byte) error) (uint32, error) {
	for {
		var magic uint64
		var gotOpt, typ, length uint32
		if err := c.read(&magic); err != nil {
			return 0, err
		}
		if err := c.read(&gotOpt); err != nil {
			return 0, err
		}
		if err := c.read(&typ); err != nil {
			return 0, err
		}
		if err := c.read(&length); err != nil {
			return 0, err
		}
		if magic != nbdOptReplyMagic || gotOpt != opt {
			return 0, errors.New("unexpected option reply")
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(c.r, payload); err != nil {
			return 0, err
		}
		if typ&nbdRepFlagError != 0 {
			return typ, fmt.Errorf("server error %#x: %s", typ, string(payload))
		}
		if typ == nbdRepAck {
			return typ, nil
		}
		if fn != nil {
			if err := fn(typ, payload); err != nil {
				return typ, err
			}
		}
	}
}

func (c *nbdClient) Size() int64 { return c.size }

func (c *nbdClient) request(cmd uint16, offset uint64, length uint32) uint64 {
	c.cookie++
	c.be32(nbdRequestMagic)
	c.be16(0)
	c.be16(cmd)
	c.be64(c.cookie)
	c.be64(offset)
	c.be32(length)
	c.w.Flush()
	return c.cookie
}

// replies reads the reply chunks of one request; fn gets each chunk.
func (c *nbdClient) replies(cookie uint64, fn func(typ uint16, payload []byte) error) error {
	for {
		var magic uint32
		if err := c.read(&magic); err != nil {
			return err
		}
		switch magic {
		case nbdSimpleReplyMagic:
			var errno uint32
			var h uint64
			c.read(&errno)
			if err := c.read(&h); err != nil {
				return err
			}
			if errno != 0 {
				return fmt.Errorf("NBD error %d", errno)
			}
			// Only non-read commands may answer simply; nothing follows.
			return nil
		case nbdStructReplyMagic:
			var flags, typ uint16
			var h uint64
			var length uint32
			c.read(&flags)
			c.read(&typ)
			c.read(&h)
			if err := c.read(&length); err != nil {
				return err
			}
			payload := make([]byte, length)
			if _, err := io.ReadFull(c.r, payload); err != nil {
				return err
			}
			if h != cookie {
				return errors.New("NBD reply for another request")
			}
			if typ&nbdReplyTypeErrorBit != 0 {
				msg := ""
				if len(payload) >= 6 {
					l := int(binary.BigEndian.Uint16(payload[4:]))
					if 6+l <= len(payload) {
						msg = string(payload[6 : 6+l])
					}
				}
				return fmt.Errorf("NBD error reply %d: %s", typ, msg)
			}
			if typ != nbdReplyTypeNone {
				if err := fn(typ, payload); err != nil {
					return err
				}
			}
			if flags&nbdReplyFlagDone != 0 {
				return nil
			}
		default:
			return fmt.Errorf("bad NBD reply magic %#x", magic)
		}
	}
}

// DirtyExtents lists the ranges whose meta-context status has the dirty bit.
func (c *nbdClient) DirtyExtents() ([]pveExtent, error) {
	if !c.hasCtx {
		return nil, errors.New("no meta context negotiated")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []pveExtent
	const chunk = 1 << 30
	for off := int64(0); off < c.size; {
		want := c.size - off
		if want > chunk {
			want = chunk
		}
		cookie := c.request(nbdCmdBlockStatus, uint64(off), uint32(want))
		covered := int64(0)
		err := c.replies(cookie, func(typ uint16, p []byte) error {
			if typ != nbdReplyTypeBlockStatus || len(p) < 4 {
				return nil
			}
			if binary.BigEndian.Uint32(p) != c.contextID {
				return nil
			}
			pos := off
			for i := 4; i+8 <= len(p); i += 8 {
				l := int64(binary.BigEndian.Uint32(p[i:]))
				st := binary.BigEndian.Uint32(p[i+4:])
				if st&nbdStateDirty != 0 {
					if n := len(out); n > 0 && out[n-1].Offset+out[n-1].Length == pos {
						out[n-1].Length += l
					} else {
						out = append(out, pveExtent{Offset: pos, Length: l})
					}
				}
				pos += l
			}
			if pos-off > covered {
				covered = pos - off
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		if covered <= 0 {
			return nil, errors.New("NBD block status made no progress")
		}
		off += covered
	}
	return out, nil
}

// ReadAt reads from the export (io.ReaderAt).
func (c *nbdClient) ReadAt(p []byte, off int64) (int, error) {
	if off >= c.size {
		return 0, io.EOF
	}
	short := false
	if int64(len(p)) > c.size-off {
		p = p[:c.size-off]
		short = true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	total := 0
	const maxReq = 32 << 20
	for total < len(p) {
		n := len(p) - total
		if n > maxReq {
			n = maxReq
		}
		base := off + int64(total)
		buf := p[total : total+n]
		cookie := c.request(nbdCmdRead, uint64(base), uint32(n))
		err := c.replies(cookie, func(typ uint16, pl []byte) error {
			switch typ {
			case nbdReplyTypeOffsetData:
				if len(pl) < 8 {
					return errors.New("short NBD data chunk")
				}
				at := int64(binary.BigEndian.Uint64(pl)) - base
				copy(buf[at:], pl[8:])
			case nbdReplyTypeOffsetHole:
				if len(pl) < 12 {
					return errors.New("short NBD hole chunk")
				}
				at := int64(binary.BigEndian.Uint64(pl)) - base
				l := int64(binary.BigEndian.Uint32(pl[8:]))
				clear(buf[at : at+l])
			}
			return nil
		})
		if err != nil {
			return total, err
		}
		total += n
	}
	if short {
		return total, io.EOF
	}
	return total, nil
}

func (c *nbdClient) Close() error {
	c.mu.Lock()
	c.request(nbdCmdDisc, 0, 0)
	c.mu.Unlock()
	return c.conn.Close()
}
