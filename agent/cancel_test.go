package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeRestic writes a shell script that stands in for the restic binary.
func fakeRestic(t *testing.T, body string, grace time.Duration) *resticRunner {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "restic")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return &resticRunner{binary: bin, cacheDir: filepath.Join(dir, "cache"), stopGrace: grace}
}

// runUntilCancelled starts the runner, cancels after the first output line and
// returns how long run took to come back after the cancel.
func runUntilCancelled(t *testing.T, r *resticRunner) (time.Duration, int, error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan struct{}, 1)
	var cancelledAt time.Time
	go func() {
		<-started
		cancelledAt = time.Now()
		cancel()
	}()
	code, err := r.run(ctx, &Task{Repository: "r", Password: "p"}, []string{"backup"},
		func(map[string]any) {
			select {
			case started <- struct{}{}:
			default:
			}
		}, nil)
	if cancelledAt.IsZero() {
		t.Fatal("run returned before the process was cancelled")
	}
	return time.Since(cancelledAt), code, err
}

func TestRunCancelInterruptsRestic(t *testing.T) {
	r := fakeRestic(t, `echo '{"message_type":"status"}'
exec sleep 30`, 30*time.Second)

	took, _, _ := runUntilCancelled(t, r)
	// SIGINT ends the process right away; nothing waits out the grace period.
	if took > 5*time.Second {
		t.Fatalf("run took %v to return after the cancel", took)
	}
}

func TestRunCancelKillsAfterGrace(t *testing.T) {
	// Ignores SIGINT, and its sleep child keeps stdout open after a kill.
	r := fakeRestic(t, `trap '' INT
echo '{"message_type":"status"}'
sleep 30`, 300*time.Millisecond)

	took, _, _ := runUntilCancelled(t, r)
	if took > 5*time.Second {
		t.Fatalf("run took %v to return after the cancel", took)
	}
}

func TestRunReportsExitCodeAndTrailingOutput(t *testing.T) {
	r := fakeRestic(t, `echo '{"message_type":"summary","snapshot_id":"abc"}'
echo 'Fatal: repository is already locked' >&2
exit 1`, time.Second)

	var logBuf strings.Builder
	var snapshot any
	code, err := r.run(context.Background(), &Task{}, []string{"backup"},
		func(msg map[string]any) { snapshot = msg["snapshot_id"] },
		func(s string) { logBuf.WriteString(s + "\n") })
	if err != nil || code != 1 {
		t.Fatalf("run = %d, %v; want exit code 1", code, err)
	}
	if snapshot != "abc" {
		t.Fatalf("JSON line not delivered: %v", snapshot)
	}
	if !strings.Contains(logBuf.String(), "Fatal: repository is already locked") {
		t.Fatalf("final stderr line lost: %q", logBuf.String())
	}
}

func TestRestoreProgress(t *testing.T) {
	got := restoreProgress(map[string]any{
		"message_type":   "status",
		"percent_done":   0.5,
		"total_files":    float64(10),
		"files_restored": float64(3),
		"files_skipped":  float64(2),
		"total_bytes":    float64(1000),
		"bytes_restored": float64(300),
		// bytes_skipped omitted: restic leaves out zero values.
	})
	want := map[string]any{
		"percentDone": 0.5,
		"bytesDone":   float64(300),
		"totalBytes":  float64(1000),
		"filesDone":   float64(5),
		"totalFiles":  float64(10),
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("restoreProgress[%s] = %v, want %v (%v)", k, got[k], v, got)
		}
	}
}

func TestCancelWatchStopsCancelledTask(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agents/me/tasks/run-1/state" || r.Header.Get("Authorization") != "Bearer key" {
			http.NotFound(w, r)
			return
		}
		// Running on the first poll, cancelled from the second on.
		if atomic.AddInt32(&calls, 1) == 1 {
			w.Write([]byte(`{"cancelled":false}`))
			return
		}
		w.Write([]byte(`{"cancelled":true}`))
	}))
	defer srv.Close()
	defer func(d time.Duration) { cancelPollInterval = d }(cancelPollInterval)
	cancelPollInterval = 10 * time.Millisecond

	a := &agent{baseURL: srv.URL, http: srv.Client(), state: State{AgentKey: "key"}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w := &cancelWatch{agent: a, taskID: "run-1", cancel: cancel}
	if w.check(ctx) {
		t.Fatal("a running task was cancelled")
	}
	go w.run(ctx)

	select {
	case <-ctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("task not cancelled after the server reported it")
	}
}

func TestCancelWatchIgnoresOlderServer(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()

	a := &agent{baseURL: srv.URL, http: srv.Client()}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w := &cancelWatch{agent: a, taskID: "run-1", cancel: cancel}
	for i := 0; i < 3; i++ {
		if w.check(ctx) {
			t.Fatal("a 404 cancelled the task")
		}
	}
	if ctx.Err() != nil || !w.warned {
		t.Fatalf("want the task running and one warning; ctx=%v warned=%v", ctx.Err(), w.warned)
	}
}
