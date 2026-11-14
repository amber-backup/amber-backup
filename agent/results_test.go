package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestTruncateMiddleKeepsHeadAndTail(t *testing.T) {
	s := strings.Repeat("a", 100) + strings.Repeat("b", 1000) + strings.Repeat("c", 100)
	got := truncateMiddle(s, 100, 100)
	if !strings.HasPrefix(got, strings.Repeat("a", 100)+"\n… 1000 bytes truncated …\n") ||
		!strings.HasSuffix(got, strings.Repeat("c", 100)) {
		t.Fatalf("unexpected truncation: %q", got)
	}
	if short := "short"; truncateMiddle(short, 2, 2) != short {
		t.Fatal("a short text was changed")
	}
	// Multi-byte characters are never split.
	u := strings.Repeat("ä", 2000)
	if got := truncateMiddle(u, 101, 101); !strings.HasPrefix(got, strings.Repeat("ä", 50)+"\n") || !json.Valid([]byte(`"`+strings.ReplaceAll(got, "\n", `\n`)+`"`)) {
		t.Fatalf("broken UTF-8 cut: %q", got[:120])
	}
}

func TestCapResultBoundsTheBody(t *testing.T) {
	huge := strings.Repeat("x", 5<<20)
	r := capResult(TaskResult{Status: "failed", Log: huge, Error: huge, RepoStatsError: huge,
		Prune: &PruneResult{Log: huge, Error: huge}, ProxmoxGuest: &ProxmoxGuestResult{Error: huge}})
	data, _ := json.Marshal(r)
	if len(data) > 2*(logHeadBytes+logTailBytes)+4*maxErrorBytes+2048 {
		t.Fatalf("capped result is still %d bytes", len(data))
	}
	if len(r.Error) > maxErrorBytes+64 || len(r.Log) > logHeadBytes+logTailBytes+64 {
		t.Fatalf("error %d / log %d bytes", len(r.Error), len(r.Log))
	}
}

func TestLogBufferIsBounded(t *testing.T) {
	var b logBuffer
	b.appendLine("first line")
	for i := 0; i < 20000; i++ {
		b.appendLine(strings.Repeat("y", 40))
	}
	b.appendLine("Fatal: the last line")
	got := b.String()
	if len(got) > logHeadBytes+logTailBytes+64 {
		t.Fatalf("log is %d bytes", len(got))
	}
	if !strings.HasPrefix(got, "first line\n") || !strings.HasSuffix(got, "Fatal: the last line\n") ||
		!strings.Contains(got, "bytes truncated") {
		t.Fatalf("head, tail or marker missing")
	}
	var small logBuffer
	small.appendLine("a")
	small.appendLine("b")
	if small.String() != "a\nb\n" {
		t.Fatalf("small log changed: %q", small.String())
	}
}

// resultServer answers result posts with the given statuses in turn (the last
// one repeats) and records the bodies.
type resultServer struct {
	*httptest.Server
	mu       sync.Mutex
	statuses []int
	bodies   []TaskResult
	calls    int32
}

func newResultServer(t *testing.T, statuses ...int) *resultServer {
	rs := &resultServer{statuses: statuses}
	rs.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/result") {
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var res TaskResult
		json.Unmarshal(body, &res)
		rs.mu.Lock()
		rs.bodies = append(rs.bodies, res)
		i := int(atomic.AddInt32(&rs.calls, 1)) - 1
		if i >= len(rs.statuses) {
			i = len(rs.statuses) - 1
		}
		status := rs.statuses[i]
		rs.mu.Unlock()
		w.WriteHeader(status)
		w.Write([]byte(`{}`))
	}))
	t.Cleanup(rs.Close)
	return rs
}

func (rs *resultServer) received() []TaskResult {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return append([]TaskResult(nil), rs.bodies...)
}

func fastRetries(t *testing.T) {
	t.Helper()
	oldMin, oldMax := resultRetryMin, resultRetryMax
	resultRetryMin, resultRetryMax = 10*time.Millisecond, 40*time.Millisecond
	t.Cleanup(func() { resultRetryMin, resultRetryMax = oldMin, oldMax })
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestPostResultRetriesUntilDelivered(t *testing.T) {
	fastRetries(t)
	srv := newResultServer(t, 503, 502, 200)
	spool := t.TempDir()
	a := &agent{baseURL: srv.URL, http: srv.Client(), spoolDir: spool}

	a.postResult("run-1", TaskResult{Status: "success", SnapshotID: "abc", Log: "log"})
	// Not delivered yet: spooled, and named as running in the next poll.
	if _, err := os.Stat(filepath.Join(spool, "run-1.json")); err != nil {
		t.Fatalf("result not spooled: %v", err)
	}
	if ids := a.runningTaskIDs(); len(ids) != 1 || ids[0] != "run-1" {
		t.Fatalf("runningTaskIDs = %v", ids)
	}
	waitUntil(t, "the delivery", func() bool { return len(a.runningTaskIDs()) == 0 })
	if got := srv.received(); len(got) != 3 || got[2].SnapshotID != "abc" || got[2].Log != "log" {
		t.Fatalf("server got %+v", got)
	}
	if _, err := os.Stat(filepath.Join(spool, "run-1.json")); !os.IsNotExist(err) {
		t.Fatalf("spool file left after delivery: %v", err)
	}
}

func TestPostResultFallsBackToMinimalResult(t *testing.T) {
	for _, status := range []int{400, 413} {
		srv := newResultServer(t, status, 200)
		a := &agent{baseURL: srv.URL, http: srv.Client(), spoolDir: t.TempDir()}
		a.postResult("run-2", TaskResult{Status: "success", SnapshotID: "snap", Log: strings.Repeat("l", 1000),
			Stats: map[string]any{"filesNew": 1}})
		got := srv.received()
		if len(got) != 2 {
			t.Fatalf("HTTP %d: want the full and the minimal result, got %d posts", status, len(got))
		}
		m := got[1]
		if m.Status != "success" || m.SnapshotID != "snap" || m.Log != "" || m.Stats != nil {
			t.Fatalf("HTTP %d: minimal result %+v", status, m)
		}
		if len(a.runningTaskIDs()) != 0 {
			t.Fatal("result still pending")
		}
	}
}

func TestPostResultDropsRejectedMinimalAndUnknownTasks(t *testing.T) {
	srv := newResultServer(t, 413)
	a := &agent{baseURL: srv.URL, http: srv.Client(), spoolDir: t.TempDir()}
	a.postResult("run-3", TaskResult{Status: "failed", Error: "boom"})
	if n := len(srv.received()); n != 2 || len(a.runningTaskIDs()) != 0 {
		t.Fatalf("want two posts and nothing pending, got %d posts, pending %v", n, a.runningTaskIDs())
	}

	gone := newResultServer(t, 404)
	b := &agent{baseURL: gone.URL, http: gone.Client(), spoolDir: t.TempDir()}
	b.postResult("run-4", TaskResult{Status: "success"})
	if n := len(gone.received()); n != 1 || len(b.runningTaskIDs()) != 0 {
		t.Fatalf("a 404 must drop the result after one post, got %d posts", n)
	}
	entries, _ := os.ReadDir(b.spoolDir)
	if len(entries) != 0 {
		t.Fatalf("spool not empty: %v", entries)
	}
}

func TestMinimalInventoryResultFails(t *testing.T) {
	m := minimalResult(TaskResult{Status: "success", ProxmoxInventory: &ProxmoxInventory{}}, 413)
	if m.Status != "failed" || m.ProxmoxInventory != nil || !strings.Contains(m.Error, "413") {
		t.Fatalf("minimal inventory result %+v", m)
	}
}

func TestResendSpooledOnStart(t *testing.T) {
	fastRetries(t)
	srv := newResultServer(t, 500, 200)
	spool := t.TempDir()
	data, _ := json.Marshal(TaskResult{Status: "failed", Error: "The agent was stopped while this task ran."})
	os.WriteFile(filepath.Join(spool, "run-5.json"), data, 0o600)
	os.WriteFile(filepath.Join(spool, "run-6.json.tmp"), []byte("{"), 0o600)

	a := &agent{baseURL: srv.URL, http: srv.Client(), spoolDir: spool}
	a.resendSpooled()
	if ids := a.runningTaskIDs(); len(ids) != 1 || ids[0] != "run-5" {
		t.Fatalf("runningTaskIDs after start = %v", ids)
	}
	waitUntil(t, "the re-sent result", func() bool { return len(a.runningTaskIDs()) == 0 })
	got := srv.received()
	if len(got) != 2 || got[1].Error != "The agent was stopped while this task ran." {
		t.Fatalf("server got %+v", got)
	}
	if entries, _ := os.ReadDir(spool); len(entries) != 0 {
		t.Fatalf("spool not empty: %v", entries)
	}
}

func TestPollAlwaysSendsRunningTaskIDs(t *testing.T) {
	var mu sync.Mutex
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		bodies = append(bodies, body)
		mu.Unlock()
		w.Write([]byte(`{"tasks":[],"pollIntervalSeconds":30}`))
	}))
	defer srv.Close()
	a := &agent{baseURL: srv.URL, http: srv.Client(), runner: &resticRunner{binary: "/nonexistent"}}
	if _, _, err := a.poll(); err != nil {
		t.Fatal(err)
	}
	a.inflight = map[string]bool{"queued-1": true}
	a.pending = map[string]bool{"spooled-1": true, "queued-1": true}
	if _, _, err := a.poll(); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	idle, ok := bodies[0]["runningTaskIds"].([]any)
	if !ok || len(idle) != 0 {
		t.Fatalf("idle poll: runningTaskIds = %#v", bodies[0]["runningTaskIds"])
	}
	busy, _ := bodies[1]["runningTaskIds"].([]any)
	if len(busy) != 2 || busy[0] != "queued-1" || busy[1] != "spooled-1" {
		t.Fatalf("busy poll: runningTaskIds = %#v", busy)
	}
}

func TestEnqueueSkipsTaskWithPendingResult(t *testing.T) {
	a := &agent{tasks: make(chan Task, 1), pending: map[string]bool{"done-1": true}}
	a.enqueue(Task{TaskID: "done-1", Type: "backup"})
	if a.active != 0 || len(a.inflight) != 0 {
		t.Fatal("a task with an undelivered result was queued again")
	}
}

// A task cancelled because the agent is stopping is reported as failed even
// when it ends before the poll loop has set shuttingDown.
func TestCancelTaskWhileAgentStopsReportsFailure(t *testing.T) {
	srv := newResultServer(t, 200)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	a := &agent{baseURL: srv.URL, http: srv.Client(), ctx: ctx}

	a.cancelTask(&Task{TaskID: "run-stop", Type: "backup"}, "log")
	got := srv.received()
	if len(got) != 1 || got[0].Status != "failed" || got[0].Error != "The agent was stopped while this task ran." {
		t.Fatalf("server got %+v", got)
	}
}

// Express rejects an over-long body with a route-level 404 "Cannot POST …":
// that is treated as too large (minimal result), not as an unknown task.
func TestPostResultTreatsCannotPost404AsTooLarge(t *testing.T) {
	var mu sync.Mutex
	var bodies []TaskResult
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var res TaskResult
		json.Unmarshal(body, &res)
		mu.Lock()
		bodies = append(bodies, res)
		first := len(bodies) == 1
		mu.Unlock()
		if first {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"message":"Cannot POST /api/agents/me/tasks/run-5/result","error":"Not Found","statusCode":404}`))
			return
		}
		w.Write([]byte(`{}`))
	}))
	t.Cleanup(srv.Close)
	a := &agent{baseURL: srv.URL, http: srv.Client(), spoolDir: t.TempDir()}
	a.postResult("run-5", TaskResult{Status: "success", SnapshotID: "snap", Log: "long log"})
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 2 || bodies[1].SnapshotID != "snap" || bodies[1].Log != "" {
		t.Fatalf("want the full and then the minimal result, got %+v", bodies)
	}
}

// A task still queued when the agent stops is failed without running.
func TestRunTaskAfterStopFailsWithoutRunning(t *testing.T) {
	srv := newResultServer(t, 200)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	a := &agent{baseURL: srv.URL, http: srv.Client(), ctx: ctx}
	a.runTask(&Task{TaskID: "run-6", Type: "backup", Options: &ResticOptions{PreScript: "exit 1"}})
	got := srv.received()
	if len(got) != 1 || got[0].Status != "failed" || got[0].Error != "The agent was stopped before it started this task." || got[0].Log != "" {
		t.Fatalf("server got %+v", got)
	}
}
