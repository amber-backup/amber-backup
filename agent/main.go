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
	"os/exec"
	"path/filepath"
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

	baseURL := strings.TrimRight(getenv("AMBER_URL", ""), "/")
	token := getenv("AMBER_TOKEN", "")
	if baseURL == "" {
		log.Fatal("AMBER_URL is required")
	}

	a := &agent{
		baseURL:  baseURL,
		http:     &http.Client{Timeout: 60 * time.Second},
		runner:   newResticRunner(),
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

	log.Printf("Amber agent %s started (agent %s)", agentVersion, a.state.AgentID)
	go a.worker()
	a.pollLoop()
}

// --- State persistence ------------------------------------------------------

func statePath() string {
	if p := os.Getenv("AMBER_STATE"); p != "" {
		return p
	}
	dir := getenv("INSTALL_DIR", "/opt/amber-agent")
	return filepath.Join(dir, "state.json")
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

func (a *agent) pollLoop() {
	interval := 30 * time.Second
	for {
		tasks, next, latest, err := a.poll()
		if err != nil {
			log.Printf("poll error: %v", err)
		} else {
			if next > 0 {
				interval = time.Duration(next) * time.Second
			}
			// Hand claimed tasks to the worker without blocking, so polling
			// continues as a heartbeat while a backup runs.
			for i := range tasks {
				a.enqueue(tasks[i])
			}
			// Only self-update while idle: maybeSelfUpdate re-execs the process,
			// which would abort an in-flight backup/restore.
			if atomic.LoadInt32(&a.active) == 0 {
				a.maybeSelfUpdate(latest) // re-execs on success and never returns
			}
		}
		time.Sleep(interval)
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

func (a *agent) poll() ([]Task, int, string, error) {
	req := PollRequest{
		ResticVersion: resticVersion(a.runner.binary),
		AgentVersion:  agentVersion,
	}
	var resp PollResponse
	if err := a.post("/api/agents/me/poll", a.state.AgentKey, req, &resp); err != nil {
		return nil, 0, "", err
	}
	return resp.Tasks, resp.PollIntervalSeconds, resp.LatestAgentVersion, nil
}

// --- Task execution ---------------------------------------------------------

func (a *agent) runTask(t *Task) {
	log.Printf("running %s task %s", t.Type, t.TaskID)
	switch t.Type {
	case "backup":
		a.runBackup(t)
	case "restore":
		a.runRestore(t)
	default:
		log.Printf("unknown task type: %s", t.Type)
	}
}

func (a *agent) runBackup(t *Task) {
	var logBuf strings.Builder
	appendLog := func(s string) { logBuf.WriteString(s + "\n") }
	result := TaskResult{Status: "success"}
	var lastProgress time.Time

	// handleFailure runs the on-failure script (best-effort) and reports the run
	// as failed. Used for pre-script, init and backup failures alike.
	handleFailure := func(msg string) {
		if t.Options != nil && t.Options.PostFailureScript != "" {
			appendLog("[post-failure-script] " + t.Options.PostFailureScript)
			if err := runScriptLogged(t.Options.PostFailureScript,
				scriptEnv(t, "post-failure", "failed", "", msg), appendLog); err != nil {
				appendLog("[post-failure-script] " + err.Error())
			}
		}
		a.failTask(t, msg, logBuf.String())
	}

	// Pre-backup script gates the run: a non-zero exit aborts the backup.
	if t.Options != nil && t.Options.PreScript != "" {
		appendLog("[pre-script] " + t.Options.PreScript)
		if err := runScriptLogged(t.Options.PreScript, scriptEnv(t, "pre", "", "", ""), appendLog); err != nil {
			handleFailure("pre-script: " + err.Error())
			return
		}
	}

	if err := a.runner.ensureInitialized(t); err != nil {
		handleFailure(err.Error())
		return
	}

	code, err := a.runner.run(t, backupArgs(t), func(msg map[string]any) {
		switch msg["message_type"] {
		case "status":
			if time.Since(lastProgress) > 2*time.Second {
				lastProgress = time.Now()
				a.postProgress(t.TaskID, map[string]any{"percentDone": msg["percent_done"]})
			}
		case "summary":
			result.SnapshotID, _ = msg["snapshot_id"].(string)
			result.Stats = summaryToStats(msg)
		}
	}, appendLog)

	if err != nil || (code != 0 && code != 3) {
		handleFailure(fmt.Sprintf("backup exited %d: %v", code, err))
		return
	}

	// Retention as part of the run (§7).
	if t.Options != nil && hasRetention(t.Options.Retention) {
		fcode, ferr := a.runner.run(t, forgetArgs(t.Options.Retention), nil, appendLog)
		if ferr != nil || fcode != 0 {
			appendLog(fmt.Sprintf("forget failed: code=%d err=%v", fcode, ferr))
		}
	}

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
	log.Printf("backup task %s complete (snapshot %s)", t.TaskID, result.SnapshotID)
}

func (a *agent) runRestore(t *Task) {
	var logBuf strings.Builder
	appendLog := func(s string) { logBuf.WriteString(s + "\n") }
	result := TaskResult{Status: "success"}
	var lastProgress time.Time

	code, err := a.runner.run(t, restoreArgs(t), func(msg map[string]any) {
		switch msg["message_type"] {
		case "status":
			if time.Since(lastProgress) > 2*time.Second {
				lastProgress = time.Now()
				a.postProgress(t.TaskID, map[string]any{"percentDone": msg["percent_done"]})
			}
		case "summary":
			result.Stats = summaryToStats(msg)
		}
	}, appendLog)

	if err != nil || code != 0 {
		a.failTask(t, fmt.Sprintf("restore exited %d: %v", code, err), logBuf.String())
		return
	}
	result.Log = logBuf.String()
	a.postResult(t.TaskID, result)
	log.Printf("restore task %s complete", t.TaskID)
}

func (a *agent) failTask(t *Task, msg, logStr string) {
	log.Printf("task %s failed: %s", t.TaskID, msg)
	a.postResult(t.TaskID, TaskResult{Status: "failed", Error: msg, Log: logStr})
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

func detectOS() string {
	if data, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
			}
		}
	}
	return "linux"
}

// runScript executes a job script by path, directly (no shell, no arguments),
// with a timeout, returning its combined output. The AMBER_* context is appended
// to the agent's own environment.
func runScript(path string, env []string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, path)
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
