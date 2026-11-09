// Command amber-agent is the remote backup agent for Amber Backup. It enrolls
// with the server using a one-time token, then polls for backup/restore tasks
// and executes restic locally on the host where the data lives (§8, §9).
package main

import (
	_ "embed"

	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Single source of truth for the agent version, shared with the server (which
// reads the same VERSION file) so self-updates compare like for like.
//
//go:embed VERSION
var versionFile string

var agentVersion = strings.TrimSpace(versionFile)

type agent struct {
	baseURL string
	http    *http.Client
	state   State
	runner  *resticRunner
	// hyperv drives Hyper-V hosts; nil when this agent can't (not Windows, no mock).
	hyperv hypervBackend

	// ctx ends when the agent is stopped (Windows service stop); running tasks
	// derive their context from it. shuttingDown tells such a stop apart from
	// a cancel on the server when a task reports why it ended.
	ctx          context.Context
	shuttingDown atomic.Bool

	// Task execution is decoupled from the poll loop so long-running backups
	// don't stall the heartbeat (which would make the server mark us offline).
	// The poll loop hands claimed tasks to a worker goroutine and keeps polling.
	tasks    chan Task
	inflight map[string]bool // task ids queued or running (dedupe)
	mu       sync.Mutex      // guards inflight
	active   int32           // atomic: number of queued+running tasks
}

func main() {
	// `amber-agent --version` is used by the self-updater to sanity-check a
	// freshly downloaded binary before swapping it in.
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--version", "-v", "version":
			fmt.Println(agentVersion)
			return
		}
	}

	platformInit()
	// Started by the Windows Service Control Manager: it drives runAgent and
	// stops it through the context.
	if runAsService(runAgent) {
		return
	}
	runAgent(context.Background())
}

// shutdownWait bounds how long a stop waits for running tasks to wind down.
const shutdownWait = 35 * time.Second

// runAgent enrolls if needed and polls for tasks until ctx ends. Then running
// tasks are cancelled (restic releases its lock) and reported as interrupted.
func runAgent(ctx context.Context) {
	baseURL := strings.TrimRight(getenv("AMBER_URL", ""), "/")
	token := getenv("AMBER_TOKEN", "")
	if baseURL == "" {
		log.Fatal("AMBER_URL is required")
	}

	a := &agent{
		baseURL:  baseURL,
		http:     &http.Client{Timeout: 60 * time.Second},
		runner:   newResticRunner(),
		hyperv:   newHypervBackend(),
		ctx:      ctx,
		tasks:    make(chan Task, 64),
		inflight: make(map[string]bool),
	}

	if err := a.loadState(); err != nil {
		if token == "" {
			log.Fatal("not enrolled and AMBER_TOKEN not set")
		}
		if err := a.enroll(token); err != nil {
			log.Fatalf("enrollment failed: %v", err)
		}
	}

	log.Printf("Amber agent %s started (agent %s, %s)", agentVersion, a.state.AgentID, platformTarget())
	go a.worker()
	a.pollLoop()

	// Stopped: ctx is done, which cancels the running task's context too.
	a.shuttingDown.Store(true)
	log.Printf("agent stopping")
	deadline := time.Now().Add(shutdownWait)
	for atomic.LoadInt32(&a.active) > 0 && time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
	}
}

// installDir holds the agent's state, configuration and (if the agent manages
// it) restic.
func installDir() string { return getenv("INSTALL_DIR", defaultInstallDir()) }

// --- State persistence ------------------------------------------------------

func statePath() string {
	if p := os.Getenv("AMBER_STATE"); p != "" {
		return p
	}
	return filepath.Join(installDir(), "state.json")
}

func (a *agent) loadState() error {
	data, err := os.ReadFile(statePath())
	if err != nil {
		return err
	}
	return json.Unmarshal(data, &a.state)
}

func (a *agent) saveState() error {
	p := statePath()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(a.state, "", "  ")
	return os.WriteFile(p, data, 0o600)
}

// --- Enrollment -------------------------------------------------------------

func (a *agent) enroll(token string) error {
	hostname, _ := os.Hostname()

	// The agent names itself: AMBER_NAME (set from the rollout command) wins,
	// falling back to the hostname. The server may still override this for
	// one-time tokens that pin an intended name.
	name := getenv("AMBER_NAME", hostname)

	// Generate an ed25519 keypair; the public key is shared for integrity checks.
	pub, _, _ := ed25519.GenerateKey(nil)
	pubPem := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pub})

	req := EnrollRequest{
		Token:        token,
		AgentName:    name,
		Hostname:     hostname,
		OS:           detectOS(),
		Pubkey:       string(pubPem),
		AgentVersion: agentVersion,
	}
	var resp EnrollResponse
	if err := a.post("/api/agents/enroll", "", req, &resp); err != nil {
		return err
	}
	a.state = State{
		AgentID:      resp.AgentID,
		AgentKey:     resp.AgentKey,
		ServerPubkey: resp.ServerPubkey,
	}
	if err := a.saveState(); err != nil {
		return fmt.Errorf("saving state: %w", err)
	}
	log.Printf("enrolled successfully as agent %s", resp.AgentID)
	return nil
}

// --- Poll loop --------------------------------------------------------------

// context is the agent's lifetime context (background when unset, e.g. in tests).
func (a *agent) context() context.Context {
	if a.ctx == nil {
		return context.Background()
	}
	return a.ctx
}

// pollLoop polls until the agent's context ends.
func (a *agent) pollLoop() {
	interval := 30 * time.Second
	ctx := a.context()
	for ctx.Err() == nil {
		resp, resticVer, err := a.poll()
		if err != nil {
			log.Printf("poll error: %v", err)
		} else {
			if resp.PollIntervalSeconds > 0 {
				interval = time.Duration(resp.PollIntervalSeconds) * time.Second
			}
			// Hand claimed tasks to the worker without blocking, so polling
			// continues as a heartbeat while a backup runs.
			for i := range resp.Tasks {
				a.enqueue(resp.Tasks[i])
			}
			// Only update while idle: maybeSelfUpdate restarts the process,
			// which would abort an in-flight backup/restore, and restic must
			// not be running while its binary is replaced.
			if atomic.LoadInt32(&a.active) == 0 {
				a.maybeUpdateRestic(resp.LatestResticVersion, resticVer)
				a.maybeSelfUpdate(resp.LatestAgentVersion) // restarts on success and never returns
			}
		}
		select {
		case <-ctx.Done():
		case <-time.After(interval):
		}
	}
}

// enqueue hands a claimed task to the worker. It never blocks the poll loop:
// duplicates (same task seen across polls) are dropped, and the channel send
// happens in its own goroutine so a busy worker can't stall the heartbeat.
func (a *agent) enqueue(t Task) {
	a.mu.Lock()
	if a.inflight[t.TaskID] {
		a.mu.Unlock()
		return
	}
	a.inflight[t.TaskID] = true
	a.mu.Unlock()

	atomic.AddInt32(&a.active, 1)
	go func() { a.tasks <- t }()
}

// worker executes tasks one at a time. Serializing restic invocations keeps the
// host load predictable and matches the previous single-task behavior; the poll
// loop meanwhile keeps sending heartbeats.
func (a *agent) worker() {
	for t := range a.tasks {
		a.runTask(&t)
		a.mu.Lock()
		delete(a.inflight, t.TaskID)
		a.mu.Unlock()
		atomic.AddInt32(&a.active, -1)
	}
}

// poll sends the heartbeat and claims tasks; it also returns the restic
// version it reported.
func (a *agent) poll() (PollResponse, string, error) {
	req := PollRequest{
		ResticVersion: resticVersion(a.runner.binary),
		AgentVersion:  agentVersion,
		Capabilities:  a.capabilities(),
	}
	var resp PollResponse
	if err := a.post("/api/agents/me/poll", a.state.AgentKey, req, &resp); err != nil {
		return PollResponse{}, req.ResticVersion, err
	}
	return resp, req.ResticVersion, nil
}

// capabilities lists the task types beyond backup/restore this agent runs.
func (a *agent) capabilities() []string {
	caps := []string{"check", "stats"}
	if a.hyperv != nil {
		caps = append(caps, "hyperv")
	}
	return caps
}

// --- Task execution ---------------------------------------------------------

// cancelPollInterval is how often a running task asks the server whether it
// was cancelled meanwhile.
var cancelPollInterval = 5 * time.Second

func (a *agent) runTask(t *Task) {
	// Every run task gets its own context, cancelled when the operator cancels
	// the task on the server. A stats task has no run row to cancel.
	ctx, cancel := context.WithCancel(a.context())
	defer cancel()
	if t.Type != "stats" && t.Type != "hyperv-inventory" {
		w := &cancelWatch{agent: a, taskID: t.TaskID, cancel: cancel}
		// A task cancelled while it waited behind another one never starts.
		if w.check(ctx) {
			a.cancelTask(t, "Cancelled before the agent started it.\n")
			return
		}
		go w.run(ctx)
	}

	log.Printf("running %s task %s", t.Type, t.TaskID)
	switch t.Type {
	case "backup":
		a.runBackup(ctx, t)
	case "restore":
		a.runRestore(ctx, t)
	case "check":
		a.runCheck(ctx, t)
	case "stats":
		a.runStats(ctx, t)
	case "hyperv-inventory":
		a.runHypervInventory(ctx, t)
	case "hyperv-backup":
		a.runHypervBackup(ctx, t)
	case "hyperv-restore":
		a.runHypervRestore(ctx, t)
	default:
		log.Printf("unknown task type: %s", t.Type)
	}
}

// cancelWatch polls the state of a running task and cancels its context once
// the server reports it cancelled. A server that predates the endpoint answers
// 404; that and transient errors are logged once per task and otherwise
// ignored, so the task simply runs to completion as before.
type cancelWatch struct {
	agent  *agent
	taskID string
	cancel context.CancelFunc
	warned bool
}

func (w *cancelWatch) run(ctx context.Context) {
	ticker := time.NewTicker(cancelPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if w.check(ctx) {
				return
			}
		}
	}
}

// check asks the server once and cancels the task if it was cancelled there.
func (w *cancelWatch) check(ctx context.Context) bool {
	var state TaskState
	err := w.agent.get(ctx, "/api/agents/me/tasks/"+w.taskID+"/state", w.agent.state.AgentKey, &state)
	if err != nil {
		if ctx.Err() == nil && !w.warned {
			w.warned = true
			log.Printf("task %s: cannot check for a cancel (ignored): %v", w.taskID, err)
		}
		return false
	}
	if !state.Cancelled {
		return false
	}
	log.Printf("task %s was cancelled on the server, stopping it", w.taskID)
	w.cancel()
	return true
}

func (a *agent) runBackup(ctx context.Context, t *Task) {
	a.runBackupFlow(ctx, t, a.backupFiles, retentionForgetArgs)
}

// backupBody runs the backup proper and fills the result's snapshot and stats;
// an error fails the run.
type backupBody func(ctx context.Context, t *Task, result *TaskResult, appendLog func(string)) error

// backupFiles backs up the task's paths with one restic run.
func (a *agent) backupFiles(ctx context.Context, t *Task, result *TaskResult, appendLog func(string)) error {
	var lastProgress time.Time
	code, err := a.runner.run(ctx, t, backupArgs(t), func(msg map[string]any) {
		switch msg["message_type"] {
		case "status":
			if time.Since(lastProgress) > time.Second {
				lastProgress = time.Now()
				// Forward live progress (percentage + bytes/files done vs total).
				a.postProgress(t.TaskID, map[string]any{
					"percentDone": msg["percent_done"],
					"bytesDone":   msg["bytes_done"],
					"totalBytes":  msg["total_bytes"],
					"filesDone":   msg["files_done"],
					"totalFiles":  msg["total_files"],
				})
			}
		case "summary":
			result.SnapshotID, _ = msg["snapshot_id"].(string)
			result.Stats = summaryToStats(msg)
		}
	}, appendLog)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	// Exit 3: some files could not be read; the snapshot exists anyway.
	if err != nil || (code != 0 && code != 3) {
		return fmt.Errorf("backup exited %d: %v", code, err)
	}
	return nil
}

// retentionForgetArgs is the forget of a file backup's retention.
func retentionForgetArgs(ret *Retention) []string { return forgetArgs(ret) }

// runBackupFlow is what every backup shares around its body: the pre-script
// gate, repository init, retention (forget + prune), the repository figures
// and the post scripts.
func (a *agent) runBackupFlow(ctx context.Context, t *Task, body backupBody, forget func(*Retention) []string) {
	var logBuf strings.Builder
	appendLog := func(s string) { logBuf.WriteString(s + "\n") }
	result := TaskResult{Status: "success"}

	// handleFailure runs the on-failure script (best-effort) and reports the run
	// as failed — or as cancelled once the operator stopped it. The script runs
	// on a cancel too: it often restarts services the pre-script stopped. It
	// runs detached from the cancelled context, bounded by its own timeout.
	handleFailure := func(msg string) {
		status := "failed"
		if ctx.Err() != nil {
			status, msg = "cancelled", "cancelled on the server"
		}
		if t.Options != nil && t.Options.PostFailureScript != "" {
			appendLog("[post-failure-script] " + t.Options.PostFailureScript)
			if err := runScriptLogged(t.Options.PostFailureScript,
				scriptEnv(t, "post-failure", status, "", msg), appendLog); err != nil {
				appendLog("[post-failure-script] " + err.Error())
			}
		}
		if status == "cancelled" {
			a.cancelTask(t, logBuf.String())
			return
		}
		// A partly failed Hyper-V backup still made snapshots; keep its stats.
		a.postResult(t.TaskID, TaskResult{
			Status: "failed", Error: msg, Log: logBuf.String(),
			SnapshotID: result.SnapshotID, Stats: result.Stats,
		})
		log.Printf("task %s failed: %s", t.TaskID, msg)
	}

	// Pre-backup script gates the run: a non-zero exit aborts the backup.
	if t.Options != nil && t.Options.PreScript != "" {
		appendLog("[pre-script] " + t.Options.PreScript)
		if err := runScriptLogged(t.Options.PreScript, scriptEnv(t, "pre", "", "", ""), appendLog); err != nil {
			handleFailure("pre-script: " + err.Error())
			return
		}
	}
	if ctx.Err() != nil {
		handleFailure("")
		return
	}

	if err := a.runner.ensureInitialized(ctx, t); err != nil {
		handleFailure(err.Error())
		return
	}

	err := body(ctx, t, &result, appendLog)
	if ctx.Err() != nil {
		if result.SnapshotID != "" {
			appendLog("backup finished before the cancel took effect: snapshot " + result.SnapshotID)
		}
		handleFailure("")
		return
	}
	if err != nil {
		handleFailure(err.Error())
		return
	}

	// Retention as part of the run (§7). Only the forget happens inside the
	// backup; the prune it may ask for is reported as an activity of its own.
	if t.Options != nil && hasRetention(t.Options.Retention) {
		fcode, ferr := a.runner.run(ctx, t, forget(t.Options.Retention), nil, appendLog)
		if ferr != nil || fcode != 0 {
			appendLog(fmt.Sprintf("forget failed: code=%d err=%v", fcode, ferr))
		} else if t.Options.Retention.Prune {
			result.Prune = a.runPrune(ctx, t)
		}
	}
	// A cancel during the forget or prune stops the rest of the run too.
	if ctx.Err() != nil {
		appendLog("backup finished before the cancel took effect: snapshot " + result.SnapshotID)
		handleFailure("")
		return
	}

	// The repository just changed (and maybe shrank through the prune): read
	// its figures here so the server doesn't have to.
	a.readRepoStats(ctx, t, &result)

	// On-success script runs after a successful backup; failure only logged.
	if t.Options != nil && t.Options.PostSuccessScript != "" {
		appendLog("[post-success-script] " + t.Options.PostSuccessScript)
		if err := runScriptLogged(t.Options.PostSuccessScript,
			scriptEnv(t, "post-success", "success", result.SnapshotID, ""), appendLog); err != nil {
			appendLog("[post-success-script] " + err.Error())
		}
	}

	result.Log = logBuf.String()
	a.postResult(t.TaskID, result)
	log.Printf("%s task %s complete (snapshot %s)", t.Type, t.TaskID, result.SnapshotID)
}

// runPrune reclaims unreferenced storage after a backup's forget. It is timed
// and logged separately so the server can show it as its own activity.
func (a *agent) runPrune(ctx context.Context, t *Task) *PruneResult {
	var logBuf strings.Builder
	appendLog := func(s string) { logBuf.WriteString(s + "\n") }
	res := &PruneResult{Status: "success", StartedAt: time.Now().UTC().Format(time.RFC3339)}
	code, err := a.runner.run(ctx, t, []string{"prune"}, nil, appendLog)
	if err != nil || code != 0 {
		res.Status = "failed"
		res.Error = fmt.Sprintf("prune exited %d: %v", code, err)
	}
	res.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	res.Log = logBuf.String()
	log.Printf("prune for task %s finished: %s", t.TaskID, res.Status)
	return res
}

func (a *agent) runRestore(ctx context.Context, t *Task) {
	var logBuf strings.Builder
	appendLog := func(s string) { logBuf.WriteString(s + "\n") }
	result := TaskResult{Status: "success"}

	steps, err := a.restoreSteps(ctx, t, appendLog)
	if err == nil {
		var totals map[string]any
		for _, step := range steps {
			stats, serr := a.restoreOnce(ctx, t, step, appendLog)
			if serr != nil {
				err = serr
				break
			}
			totals = addRestoreStats(totals, stats)
		}
		result.Stats = totals
	}

	if ctx.Err() != nil {
		a.cancelTask(t, logBuf.String())
		return
	}
	if err != nil {
		a.failTask(t, err.Error(), logBuf.String())
		return
	}
	result.Log = logBuf.String()
	a.postResult(t.TaskID, result)
	log.Printf("restore task %s complete", t.TaskID)
}

// restoreSteps plans the restic restores a task needs: one, or on Windows for
// the original location one per drive (see planDriveRestores).
func (a *agent) restoreSteps(ctx context.Context, t *Task, appendLog func(string)) ([][]string, error) {
	if runtime.GOOS != "windows" || !isOriginalLocation(t.TargetPath) {
		return [][]string{restoreArgs(t)}, nil
	}
	includes := restoreIncludes(t)
	var topLevel []string
	if len(includes) == 0 {
		var err error
		if topLevel, err = a.snapshotTopLevel(ctx, t); err != nil {
			return nil, err
		}
	}
	plan := planDriveRestores(t.SnapshotID, includes, topLevel)
	if len(plan) == 0 {
		return nil, fmt.Errorf("nothing in the snapshot belongs to a drive, so it has no original location on this host; restore to a path instead")
	}
	steps := make([][]string, 0, len(plan))
	for _, p := range plan {
		appendLog(fmt.Sprintf("restoring drive %s: to %s", p.Drive, p.Target))
		steps = append(steps, restoreArgsFor(p.Snapshot, p.Target, p.Includes, t.RestoreOptions))
	}
	return steps, nil
}

// snapshotTopLevel lists the snapshot's top-level directories (on Windows: one
// per drive, e.g. /C).
func (a *agent) snapshotTopLevel(ctx context.Context, t *Task) ([]string, error) {
	var top []string
	code, err := a.runner.run(ctx, t, []string{"ls", "--json", "--", t.SnapshotID, "/"}, func(msg map[string]any) {
		if p, _ := msg["path"].(string); p != "" && strings.Count(p, "/") == 1 {
			top = append(top, p)
		}
	}, nil)
	if err != nil || code != 0 {
		return nil, fmt.Errorf("listing snapshot %s exited %d: %v", t.SnapshotID, code, err)
	}
	return top, nil
}

// restoreOnce runs one restic restore, forwarding its progress.
func (a *agent) restoreOnce(ctx context.Context, t *Task, args []string, appendLog func(string)) (map[string]any, error) {
	var stats map[string]any
	var lastProgress time.Time
	code, err := a.runner.run(ctx, t, args, func(msg map[string]any) {
		switch msg["message_type"] {
		case "status":
			if time.Since(lastProgress) > time.Second {
				lastProgress = time.Now()
				a.postProgress(t.TaskID, restoreProgress(msg))
			}
		case "summary":
			stats = restoreSummaryToStats(msg)
		}
	}, appendLog)
	if err != nil || code != 0 {
		return nil, fmt.Errorf("restore exited %d: %v", code, err)
	}
	return stats, nil
}

// runCheck verifies the repository. Damage found by restic is reported as a
// failed result flagged Damaged; any other non-zero exit means the check could
// not run (lock, backend, password) and is reported as a plain failure.
func (a *agent) runCheck(ctx context.Context, t *Task) {
	var logBuf strings.Builder
	appendLog := func(s string) { logBuf.WriteString(s + "\n") }

	code, err := a.runner.run(ctx, t, checkArgs(t), nil, appendLog)
	switch {
	case ctx.Err() != nil:
		a.cancelTask(t, logBuf.String())
	case err == nil && code == 0:
		a.postResult(t.TaskID, TaskResult{Status: "success", Log: logBuf.String()})
		log.Printf("check task %s passed", t.TaskID)
	case err == nil && isDamagedCheckOutput(logBuf.String()):
		a.postResult(t.TaskID, TaskResult{
			Status:  "failed",
			Damaged: true,
			Error:   "Integrity errors found — the log lists the damaged data and how to repair it",
			Log:     logBuf.String(),
		})
		log.Printf("check task %s found integrity errors", t.TaskID)
	default:
		a.failTask(t, fmt.Sprintf("check exited %d: %v", code, err), logBuf.String())
	}
}

// runStats reads the repository figures the server asked for.
func (a *agent) runStats(ctx context.Context, t *Task) {
	result := TaskResult{Status: "success"}
	a.readRepoStats(ctx, t, &result)
	if result.RepoStats == nil {
		result.Status = "failed"
		result.Error = result.RepoStatsError
	}
	a.postResult(t.TaskID, result)
	log.Printf("stats task %s finished: %s", t.TaskID, result.Status)
}

// readRepoStats runs `restic stats` and puts the figures — or why they could
// not be read — on the result.
func (a *agent) readRepoStats(ctx context.Context, t *Task, result *TaskResult) {
	var logBuf strings.Builder
	var stats map[string]any
	code, err := a.runner.run(ctx, t, statsArgs(), func(msg map[string]any) { stats = msg },
		func(s string) { logBuf.WriteString(s + "\n") })
	if err != nil || code != 0 || stats == nil {
		msg := strings.TrimSpace(logBuf.String())
		if msg == "" {
			msg = fmt.Sprintf("stats exited %d: %v", code, err)
		}
		result.RepoStatsError = msg
		return
	}
	result.RepoStats = repoStatsFrom(stats)
}

func (a *agent) failTask(t *Task, msg, logStr string) {
	log.Printf("task %s failed: %s", t.TaskID, msg)
	a.postResult(t.TaskID, TaskResult{Status: "failed", Error: msg, Log: logStr})
}

// cancelTask reports a task stopped because it was cancelled on the server —
// or, when the agent itself is being stopped, as failed: nobody cancelled it.
func (a *agent) cancelTask(t *Task, logStr string) {
	if a.shuttingDown.Load() {
		a.failTask(t, "The agent was stopped while this task ran.", logStr)
		return
	}
	log.Printf("%s task %s cancelled", t.Type, t.TaskID)
	a.postResult(t.TaskID, TaskResult{Status: "cancelled", Log: logStr})
}

func (a *agent) postProgress(taskID string, stats map[string]any) {
	_ = a.post("/api/agents/me/tasks/"+taskID+"/progress", a.state.AgentKey,
		map[string]any{"stats": stats}, nil)
}

func (a *agent) postResult(taskID string, result TaskResult) {
	if err := a.post("/api/agents/me/tasks/"+taskID+"/result", a.state.AgentKey, result, nil); err != nil {
		log.Printf("failed to post result for %s: %v", taskID, err)
	}
}

// --- HTTP helper ------------------------------------------------------------

func (a *agent) post(path, bearer string, body any, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, a.baseURL+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return a.do(req, bearer, out)
}

// get fetches a JSON resource; ctx aborts the request (e.g. when a task ends).
func (a *agent) get(ctx context.Context, path, bearer string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.baseURL+path, nil)
	if err != nil {
		return err
	}
	return a.do(req, bearer, out)
}

// do sends a request and decodes a JSON response body into out (if non-nil).
func (a *agent) do(req *http.Request, bearer string, out any) error {
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	if out != nil && len(respBody) > 0 {
		return json.Unmarshal(respBody, out)
	}
	return nil
}

// --- Helpers ----------------------------------------------------------------

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// runScript executes a job script by path, directly (no shell, no arguments;
// PowerShell scripts via powershell.exe on Windows), with a timeout, returning
// its combined output. The AMBER_* context is appended to the agent's own
// environment.
func runScript(path string, env []string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := scriptCommand(ctx, path)
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// runScriptLogged runs a script and appends any output to the run log.
func runScriptLogged(path string, env []string, appendLog func(string)) error {
	out, err := runScript(path, env)
	if out != "" {
		appendLog(out)
	}
	return err
}

// scriptEnv builds the AMBER_* environment handed to a job script.
func scriptEnv(t *Task, hook, status, snapshotID, errMsg string) []string {
	env := []string{
		"AMBER_HOOK=" + hook,
		"AMBER_JOB_ID=" + t.JobID,
		"AMBER_JOB_NAME=" + t.JobName,
		"AMBER_RUN_ID=" + t.TaskID,
		"AMBER_PATHS=" + strings.Join(t.Paths, "\n"),
	}
	if status != "" {
		env = append(env, "AMBER_STATUS="+status)
	}
	if snapshotID != "" {
		env = append(env, "AMBER_SNAPSHOT_ID="+snapshotID)
	}
	if errMsg != "" {
		env = append(env, "AMBER_ERROR="+errMsg)
	}
	return env
}

func summaryToStats(msg map[string]any) map[string]any {
	num := func(k string) any { return msg[k] }
	return map[string]any{
		"filesNew":            num("files_new"),
		"filesChanged":        num("files_changed"),
		"filesUnmodified":     num("files_unmodified"),
		"dataAdded":           num("data_added"),
		"totalBytesProcessed": num("total_bytes_processed"),
		"totalFilesProcessed": num("total_files_processed"),
		"totalDuration":       num("total_duration"),
		"percentDone":         1,
	}
}
