package main

// restic helpers the Proxmox tasks need beyond resticRunner.run: binary
// output (restic dump) streamed to a writer, and reading a snapshot's tree
// and metadata.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// runToWriter runs restic with stdout going to w (e.g. `restic dump`);
// stderr lines go to onLog. Cancelling ctx interrupts restic like run does.
func (r *resticRunner) runToWriter(ctx context.Context, t *Task, args []string, w io.Writer, onLog func(string)) (int, error) {
	workDir, err := os.MkdirTemp(tempBaseDir(), "amber-restic-")
	if err != nil {
		return -1, err
	}
	defer os.RemoveAll(workDir)
	env, credPaths, err := r.prepareEnv(t, workDir)
	if err != nil {
		return -1, err
	}
	os.MkdirAll(r.cacheDir, 0o700)
	fullArgs := append(substituteCredentialPaths(t.ExtraArgs, credPaths), args...)
	cmd := exec.CommandContext(ctx, r.binary, fullArgs...)
	cmd.Env = env
	prepareResticCmd(cmd)
	cmd.WaitDelay = r.stopGrace
	cmd.Stdout = w
	stderr, stderrW := io.Pipe()
	cmd.Stderr = stderrW
	if err := cmd.Start(); err != nil {
		return -1, err
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			if onLog != nil {
				onLog(sc.Text())
			}
		}
		io.Copy(io.Discard, stderr)
	}()
	err = cmd.Wait()
	stderrW.Close()
	<-done
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

// dumpFile reads one (small) file of a snapshot into memory.
func (a *agent) dumpFile(ctx context.Context, t *Task, snapshot, path string) ([]byte, error) {
	var buf bytes.Buffer
	var logBuf strings.Builder
	code, err := a.runner.runToWriter(ctx, t, []string{"dump", "--", snapshot, path}, &buf,
		func(s string) { logBuf.WriteString(s + "\n") })
	if err != nil || code != 0 {
		return nil, fmt.Errorf("restic dump %s exited %d: %v %s", path, code, err, strings.TrimSpace(logBuf.String()))
	}
	return buf.Bytes(), nil
}

// resticSnapshotInfo is the part of `restic snapshots --json` the restore needs.
type resticSnapshotInfo struct {
	ID       string    `json:"id"`
	Time     time.Time `json:"time"`
	Paths    []string  `json:"paths"`
	Tags     []string  `json:"tags"`
	Hostname string    `json:"hostname"`
}

func (a *agent) snapshotInfo(ctx context.Context, t *Task, id string) (*resticSnapshotInfo, error) {
	var buf bytes.Buffer
	var logBuf strings.Builder
	code, err := a.runner.runToWriter(ctx, t, []string{"snapshots", "--json", "--", id}, &buf,
		func(s string) { logBuf.WriteString(s + "\n") })
	if err != nil || code != 0 {
		return nil, fmt.Errorf("restic snapshots exited %d: %v %s", code, err, strings.TrimSpace(logBuf.String()))
	}
	var list []resticSnapshotInfo
	if err := json.Unmarshal(buf.Bytes(), &list); err != nil {
		return nil, fmt.Errorf("reading the snapshot list: %w", err)
	}
	if len(list) != 1 || len(list[0].Paths) == 0 {
		return nil, fmt.Errorf("snapshot %s not found", id)
	}
	return &list[0], nil
}

// snapshotFileTimes lists the regular files below prefix in a snapshot with
// their mtime and size (`restic ls --json`), keyed by path.
func (a *agent) snapshotFileTimes(ctx context.Context, t *Task, snapshot, prefix string) (map[string]segParentInfo, error) {
	out := map[string]segParentInfo{}
	var logBuf strings.Builder
	code, err := a.runner.run(ctx, t, []string{"ls", "--json", "--", snapshot}, func(msg map[string]any) {
		if msg["struct_type"] != "node" || msg["type"] != "file" {
			return
		}
		p, _ := msg["path"].(string)
		if !strings.HasPrefix(p, prefix) {
			return
		}
		mt, _ := msg["mtime"].(string)
		tm, perr := time.Parse(time.RFC3339Nano, mt)
		if perr != nil {
			return
		}
		out[p] = segParentInfo{Mtime: tm, Size: int64(jsonNum(msg, "size"))}
	}, func(s string) { logBuf.WriteString(s + "\n") })
	if err != nil || code != 0 {
		return nil, fmt.Errorf("restic ls exited %d: %v %s", code, err, strings.TrimSpace(logBuf.String()))
	}
	return out, nil
}
