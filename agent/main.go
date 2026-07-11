// Command amber-agent is the remote backup agent for Amber Backup. It enrolls
// with the server using a one-time token, then polls for backup/restore tasks
// and executes restic locally on the host where the data lives (§8, §9).
package main

import (
	_ "embed"

	"bytes"
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
		baseURL: baseURL,
		http:    &http.Client{Timeout: 60 * time.Second},
		runner:  newResticRunner(),
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
			// Run any dispatched work first, then self-update at the end of the
			// cycle so a pending update never drops tasks we already claimed.
			for i := range tasks {
				a.runTask(&tasks[i])
			}
			a.maybeSelfUpdate(latest) // re-execs on success and never returns
		}
		time.Sleep(interval)
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

	if t.Options != nil && t.Options.PreHook != "" {
		if err := runHook(t.Options.PreHook); err != nil {
			a.failTask(t, "pre-hook: "+err.Error(), logBuf.String())
			return
		}
	}

	if err := a.runner.ensureInitialized(t); err != nil {
		a.failTask(t, err.Error(), logBuf.String())
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
		a.failTask(t, fmt.Sprintf("backup exited %d: %v", code, err), logBuf.String())
		return
	}

	// Retention as part of the run (§7).
	if t.Options != nil && hasRetention(t.Options.Retention) {
		fcode, ferr := a.runner.run(t, forgetArgs(t.Options.Retention), nil, appendLog)
		if ferr != nil || fcode != 0 {
			appendLog(fmt.Sprintf("forget failed: code=%d err=%v", fcode, ferr))
		}
	}

	if t.Options != nil && t.Options.PostHook != "" {
		if err := runHook(t.Options.PostHook); err != nil {
			appendLog("post-hook: " + err.Error())
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

func runHook(command string) error {
	cmd := exec.Command("sh", "-c", command)
	return cmd.Run()
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
