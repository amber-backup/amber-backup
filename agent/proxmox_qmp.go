package main

// A minimal QMP (QEMU Machine Protocol) client: greeting, qmp_capabilities,
// then one command at a time. Used for the block method's dirty bitmaps and
// the temporary NBD export that reads them.
//
// ASSUMPTION(pve): PVE's QMP socket is /var/run/qemu-server/<vmid>.qmp and
// accepts a short-lived extra client next to PVE's own (PVE connects per
// command); Amber keeps its connections short so it never blocks PVE.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync/atomic"
	"time"
)

type qmpClient struct {
	conn net.Conn
	r    *bufio.Reader
	seq  atomic.Int64
}

// qmpError is an error QEMU returned for a command.
type qmpError struct {
	Class string `json:"class"`
	Desc  string `json:"desc"`
}

func (e *qmpError) Error() string { return e.Class + ": " + e.Desc }

func qmpDial(ctx context.Context, socket string) (*qmpClient, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, err
	}
	c := &qmpClient{conn: conn, r: bufio.NewReaderSize(conn, 1<<20)}
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
	} else {
		conn.SetDeadline(time.Now().Add(2 * time.Minute))
	}
	// Greeting: {"QMP": {...}}
	line, err := c.r.ReadBytes('\n')
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("QMP greeting: %w", err)
	}
	var greet map[string]json.RawMessage
	if json.Unmarshal(line, &greet) != nil || greet["QMP"] == nil {
		conn.Close()
		return nil, fmt.Errorf("QMP greeting: unexpected %q", string(line))
	}
	if err := c.Execute("qmp_capabilities", nil, nil); err != nil {
		conn.Close()
		return nil, err
	}
	return c, nil
}

func (c *qmpClient) Close() error { return c.conn.Close() }

// Execute runs one command; out (if non-nil) receives its "return" value.
func (c *qmpClient) Execute(cmd string, args any, out any) error {
	id := fmt.Sprintf("amber-%d", c.seq.Add(1))
	req := map[string]any{"execute": cmd, "id": id}
	if args != nil {
		req["arguments"] = args
	}
	data, _ := json.Marshal(req)
	if _, err := c.conn.Write(append(data, '\n')); err != nil {
		return err
	}
	for {
		line, err := c.r.ReadBytes('\n')
		if err != nil {
			return fmt.Errorf("QMP %s: %w", cmd, err)
		}
		var resp struct {
			Event  string          `json:"event"`
			ID     string          `json:"id"`
			Return json.RawMessage `json:"return"`
			Error  *qmpError       `json:"error"`
		}
		if err := json.Unmarshal(line, &resp); err != nil {
			return fmt.Errorf("QMP %s: bad reply %q", cmd, string(line))
		}
		if resp.Event != "" || (resp.ID != "" && resp.ID != id) {
			continue // events and stale replies
		}
		if resp.Error != nil {
			return resp.Error
		}
		if out != nil && len(resp.Return) > 0 {
			return json.Unmarshal(resp.Return, out)
		}
		return nil
	}
}

// qmpBlockInfo is the part of query-block Amber uses.
type qmpBlockInfo struct {
	Device   string `json:"device"`
	Qdev     string `json:"qdev"`
	Inserted *struct {
		NodeName     string `json:"node-name"`
		DirtyBitmaps []struct {
			Name string `json:"name"`
		} `json:"dirty-bitmaps"`
	} `json:"inserted"`
	// Older QEMU lists bitmaps at the device level.
	DirtyBitmaps []struct {
		Name string `json:"name"`
	} `json:"dirty-bitmaps"`
}

// qmpNodeFor finds the block node of a VM disk (config key scsi0, …).
// ASSUMPTION(pve): with -drive (PVE ≤ 8) the device is "drive-<key>"; with
// -blockdev (PVE 9) the top node is named "drive-<key>" and the qdev id ends
// in the key. The node-name of the inserted medium is what bitmaps and NBD
// exports attach to.
func qmpNodeFor(blocks []qmpBlockInfo, key string) (string, *qmpBlockInfo, error) {
	want := "drive-" + key
	for i := range blocks {
		b := &blocks[i]
		if b.Inserted == nil {
			continue
		}
		if b.Device == want || b.Inserted.NodeName == want || b.Qdev == key || hasSuffixPath(b.Qdev, key) {
			return b.Inserted.NodeName, b, nil
		}
	}
	return "", nil, fmt.Errorf("disk %s not found in QEMU's block devices", key)
}

func hasSuffixPath(qdev, key string) bool {
	return len(qdev) > len(key) && qdev[len(qdev)-len(key)-1] == '/' && qdev[len(qdev)-len(key):] == key
}

func (b *qmpBlockInfo) hasBitmap(name string) bool {
	for _, bm := range b.DirtyBitmaps {
		if bm.Name == name {
			return true
		}
	}
	if b.Inserted != nil {
		for _, bm := range b.Inserted.DirtyBitmaps {
			if bm.Name == name {
				return true
			}
		}
	}
	return false
}

var errNoBitmap = errors.New("the dirty bitmap does not exist (VM restarted or migrated)")
