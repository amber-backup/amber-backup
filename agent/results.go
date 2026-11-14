package main

// Delivery of task results. A result is the only way a run on the server ever
// settles, so it must survive a server restart, a network outage and an agent
// restart: it is spooled to disk before it is sent, retried with backoff
// until the server acknowledges it, and re-sent on the next start. Its log and
// error are capped so the body always fits what the server accepts.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	// A log keeps its first logHeadBytes and its last logTailBytes; the
	// middle is replaced by a marker.
	logHeadBytes = 4 << 10
	logTailBytes = 64 << 10
	// Error texts are capped at about maxErrorBytes (head and tail kept).
	maxErrorBytes = 4 << 10
)

// Backoff between delivery attempts of one result.
var (
	resultRetryMin = 5 * time.Second
	resultRetryMax = 5 * time.Minute
)

// httpError is a non-2xx answer of the server.
type httpError struct {
	Status int
	Body   string
}

func (e *httpError) Error() string { return fmt.Sprintf("HTTP %d: %s", e.Status, e.Body) }

// httpStatus is the status of a server answer behind err, 0 for a transport error.
func httpStatus(err error) int {
	var he *httpError
	if errors.As(err, &he) {
		return he.Status
	}
	return 0
}

// --- capping -------------------------------------------------------------------

func truncatedMarker(n int) string { return fmt.Sprintf("\n… %d bytes truncated …\n", n) }

// truncateMiddle keeps the first head and the last tail bytes of s (cut at
// UTF-8 boundaries) with a marker naming what was dropped in between.
func truncateMiddle(s string, head, tail int) string {
	if len(s) <= head+tail+len(truncatedMarker(len(s))) {
		return s
	}
	h := head
	for h > 0 && !utf8.RuneStart(s[h]) {
		h--
	}
	t := len(s) - tail
	for t < len(s) && !utf8.RuneStart(s[t]) {
		t++
	}
	return s[:h] + truncatedMarker(t-h) + s[t:]
}

func capLog(s string) string   { return truncateMiddle(s, logHeadBytes, logTailBytes) }
func capError(s string) string { return truncateMiddle(s, maxErrorBytes/4, maxErrorBytes*3/4) }

// capResult bounds the free-text fields of a result.
func capResult(r TaskResult) TaskResult {
	r.Log = capLog(r.Log)
	r.Error = capError(r.Error)
	r.RepoStatsError = capError(r.RepoStatsError)
	if r.Prune != nil {
		p := *r.Prune
		p.Log = capLog(p.Log)
		p.Error = capError(p.Error)
		r.Prune = &p
	}
	if r.ProxmoxGuest != nil {
		g := *r.ProxmoxGuest
		g.Error = capError(g.Error)
		r.ProxmoxGuest = &g
	}
	return r
}

// minimalResult is what is left of a result the server rejected as too large
// or invalid: the outcome without the log. An inventory is the substance of
// its result, so without it the task failed.
func minimalResult(r TaskResult, status int) TaskResult {
	m := TaskResult{Status: r.Status, SnapshotID: r.SnapshotID, Damaged: r.Damaged, Error: capError(r.Error)}
	if r.HypervInventory != nil || r.ProxmoxInventory != nil {
		m.Status = "failed"
		m.Error = fmt.Sprintf("The server rejected the inventory (HTTP %d).", status)
	}
	if m.Status == "failed" && m.Error == "" {
		m.Error = fmt.Sprintf("The server rejected the full result (HTTP %d); the log was dropped.", status)
	}
	return m
}

// logBuffer collects a run log in bounded memory: the first logHeadBytes and
// the last logTailBytes, with a marker for what was dropped in between. It is
// safe for concurrent use.
type logBuffer struct {
	mu      sync.Mutex
	head    []byte
	tail    []byte
	dropped int
}

func (b *logBuffer) WriteString(s string) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(s)
	if room := logHeadBytes - len(b.head); room > 0 {
		if room > len(s) {
			room = len(s)
		}
		b.head = append(b.head, s[:room]...)
		s = s[room:]
	}
	b.tail = append(b.tail, s...)
	// Compact once the tail holds twice what it keeps (amortised O(1)).
	if len(b.tail) > 2*logTailBytes {
		cut := len(b.tail) - logTailBytes
		b.dropped += cut
		b.tail = append(b.tail[:0:0], b.tail[cut:]...)
	}
	return n, nil
}

// appendLine adds one log line.
func (b *logBuffer) appendLine(s string) { b.WriteString(s + "\n") }

func (b *logBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	tail := b.tail
	dropped := b.dropped
	if len(tail) > logTailBytes {
		dropped += len(tail) - logTailBytes
		tail = tail[len(tail)-logTailBytes:]
	}
	if dropped == 0 {
		return string(b.head) + string(tail)
	}
	// Start the tail on a whole character.
	i := 0
	for i < len(tail) && i < utf8.UTFMax && !utf8.RuneStart(tail[i]) {
		i++
	}
	return string(b.head) + truncatedMarker(dropped+i) + string(tail[i:])
}

// --- spooling and delivery -----------------------------------------------------

// resultsDir is where undelivered results are spooled: next to the agent's
// state, i.e. installDir()/results, or on the Docker agent's state volume
// (AMBER_STATE) so they survive a recreated container.
func resultsDir() string { return filepath.Join(filepath.Dir(statePath()), "results") }

// spoolNameRE are task ids usable as a file name on every platform.
var spoolNameRE = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}$`)

// spoolPath is where a result waits for delivery ("" = not spooled).
func (a *agent) spoolPath(taskID string) string {
	if a.spoolDir == "" || !spoolNameRE.MatchString(taskID) {
		return ""
	}
	return filepath.Join(a.spoolDir, taskID+".json")
}

func (a *agent) spool(taskID string, r TaskResult) {
	p := a.spoolPath(taskID)
	if p == "" {
		return
	}
	data, err := json.Marshal(r)
	if err == nil {
		err = os.MkdirAll(a.spoolDir, 0o700)
	}
	if err == nil {
		tmp := p + ".tmp"
		if err = os.WriteFile(tmp, data, 0o600); err == nil {
			err = os.Rename(tmp, p)
		}
	}
	if err != nil {
		log.Printf("cannot spool the result of %s (it is kept in memory only): %v", taskID, err)
	}
}

func (a *agent) unspool(taskID string) {
	if p := a.spoolPath(taskID); p != "" {
		os.Remove(p)
	}
}

// markPending records a result as not yet delivered; false when it already is
// (a delivery loop owns it).
func (a *agent) markPending(taskID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.pending == nil {
		a.pending = map[string]bool{}
	}
	if a.pending[taskID] {
		return false
	}
	a.pending[taskID] = true
	return true
}

func (a *agent) clearPending(taskID string) {
	a.mu.Lock()
	delete(a.pending, taskID)
	a.mu.Unlock()
}

// runningTaskIDs are the tasks this agent received and has not reported yet:
// waiting for the worker, running, or with a result awaiting delivery. Never
// nil, so the poll always carries the field.
func (a *agent) runningTaskIDs() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	ids := []string{}
	for id := range a.inflight {
		ids = append(ids, id)
	}
	for id := range a.pending {
		if !a.inflight[id] {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// postResult reports a task's outcome. It spools the result, tries once right
// away and, if that fails, keeps retrying in the background — so a busy server
// never stalls the worker, and the result outlives an agent restart.
func (a *agent) postResult(taskID string, result TaskResult) {
	result = capResult(result)
	if !a.markPending(taskID) {
		log.Printf("a result for %s is already being delivered; dropping the second one", taskID)
		return
	}
	a.spool(taskID, result)
	if a.deliverOnce(taskID, &result) {
		return
	}
	go a.deliverLoop(taskID, result)
}

// deliverOnce sends a result once; true when it is settled (delivered,
// unknown to the server, or rejected even in its minimal form).
func (a *agent) deliverOnce(taskID string, result *TaskResult) bool {
	err := a.post("/api/agents/me/tasks/"+taskID+"/result", a.state.AgentKey, *result, nil)
	settled := false
	status := httpStatus(err)
	// Express answers a body its parser refused with a route-level 404
	// ("Cannot POST …") instead of 413: that is a too-large result, not a
	// task the server forgot.
	if status == http.StatusNotFound && strings.Contains(err.Error(), "Cannot POST") {
		status = http.StatusRequestEntityTooLarge
	}
	switch {
	case err == nil:
		settled = true
	case status == http.StatusNotFound:
		log.Printf("the server does not know task %s any more; dropping its result", taskID)
		settled = true
	case status == http.StatusBadRequest || status == http.StatusRequestEntityTooLarge:
		if result.minimal {
			log.Printf("the server rejected even the minimal result of %s; dropping it: %v", taskID, err)
			settled = true
			break
		}
		log.Printf("the server rejected the result of %s (%v); sending it without its log", taskID, err)
		*result = minimalResult(*result, status)
		result.minimal = true
		a.spool(taskID, *result)
		return a.deliverOnce(taskID, result)
	default:
		log.Printf("failed to post result for %s (will retry): %v", taskID, err)
	}
	if settled {
		a.unspool(taskID)
		a.clearPending(taskID)
	}
	return settled
}

// deliverLoop retries a result with exponential backoff until it is settled
// or the agent stops (it stays spooled for the next start then).
func (a *agent) deliverLoop(taskID string, result TaskResult) {
	ctx := a.context()
	wait := resultRetryMin
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if a.deliverOnce(taskID, &result) {
			return
		}
		if wait *= 2; wait > resultRetryMax {
			wait = resultRetryMax
		}
	}
}

// resendSpooled picks up the results a previous run of the agent could not
// deliver. They count as pending at once (so the first poll names them) and
// are sent in the background.
func (a *agent) resendSpooled() {
	if a.spoolDir == "" {
		return
	}
	entries, err := os.ReadDir(a.spoolDir)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("reading spooled results: %v", err)
		}
		return
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() {
			continue
		}
		if strings.HasSuffix(name, ".json.tmp") {
			os.Remove(filepath.Join(a.spoolDir, name))
			continue
		}
		taskID, ok := strings.CutSuffix(name, ".json")
		if !ok || !spoolNameRE.MatchString(taskID) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(a.spoolDir, name))
		var r TaskResult
		if err == nil {
			err = json.Unmarshal(data, &r)
		}
		if err != nil {
			log.Printf("dropping unreadable spooled result %s: %v", name, err)
			os.Remove(filepath.Join(a.spoolDir, name))
			continue
		}
		if !a.markPending(taskID) {
			continue
		}
		log.Printf("re-sending the undelivered result of %s", taskID)
		go func() {
			if !a.deliverOnce(taskID, &r) {
				a.deliverLoop(taskID, r)
			}
		}()
	}
}
