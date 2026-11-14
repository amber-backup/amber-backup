//go:build !windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// scriptedRestic is a fake restic that logs each invocation's arguments to
// a file and runs the shell snippet given for its subcommand.
func scriptedRestic(t *testing.T, cases map[string]string) (*resticRunner, func() []string) {
	t.Helper()
	dir := t.TempDir()
	calls := filepath.Join(dir, "calls")
	var body strings.Builder
	body.WriteString("echo \"$*\" >> '" + calls + "'\ncase \"$1\" in\n")
	for sub, snippet := range cases {
		body.WriteString(sub + ")\n" + snippet + "\n;;\n")
	}
	body.WriteString("esac\nexit 0\n")
	r := fakeRestic(t, body.String(), time.Second)
	return r, func() []string {
		data, _ := os.ReadFile(calls)
		return strings.Split(strings.TrimSpace(string(data)), "\n")
	}
}

func hasCall(calls []string, prefix string) bool {
	for _, c := range calls {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}

const missingRepo = `echo 'Fatal: repository does not exist: unable to open config file' >&2
exit 10`

func TestEnsureInitializedCreatesOnlyANewRepository(t *testing.T) {
	r, calls := scriptedRestic(t, map[string]string{"cat": missingRepo})
	var logBuf logBuffer
	if err := r.ensureInitialized(context.Background(), &Task{Repository: "/mnt/new"}, logBuf.appendLine); err != nil {
		t.Fatalf("ensureInitialized: %v", err)
	}
	if !hasCall(calls(), "init") {
		t.Fatalf("a missing, never-seen repository was not initialised: %v", calls())
	}
	if !strings.Contains(logBuf.String(), "repository does not exist") {
		t.Fatalf("cat config's stderr is not in the log: %q", logBuf.String())
	}
}

func TestEnsureInitializedNeverRecreatesAKnownRepository(t *testing.T) {
	r, calls := scriptedRestic(t, map[string]string{"cat": missingRepo})
	task := &Task{Repository: "rest:https://amber:s3cret@nas/repo", RepoInitialized: true}
	err := r.ensureInitialized(context.Background(), task, nil)
	if err == nil || !strings.Contains(err.Error(), "Repository not found at rest:https://***@nas/repo") ||
		!strings.Contains(err.Error(), "is the target mounted and reachable?") {
		t.Fatalf("want a not-found error, got %v", err)
	}
	if strings.Contains(err.Error(), "s3cret") {
		t.Fatalf("the error leaks the repository password: %v", err)
	}
	if hasCall(calls(), "init") {
		t.Fatalf("a repository that held backups was re-created: %v", calls())
	}
}

func TestEnsureInitializedDoesNotInitOnOtherErrors(t *testing.T) {
	r, calls := scriptedRestic(t, map[string]string{"cat": `echo 'Fatal: wrong password or no key found' >&2
exit 12`})
	var logBuf logBuffer
	err := r.ensureInitialized(context.Background(), &Task{Repository: "/repo"}, logBuf.appendLine)
	if err == nil || !strings.Contains(err.Error(), "wrong password or no key found") || !strings.Contains(err.Error(), "exited 12") {
		t.Fatalf("want restic's own error, got %v", err)
	}
	if hasCall(calls(), "init") {
		t.Fatalf("init ran although the repository exists: %v", calls())
	}
	if !strings.Contains(logBuf.String(), "wrong password") {
		t.Fatalf("stderr not logged: %q", logBuf.String())
	}
}

// restic < 0.17 exits 1 for a missing repository: no init, but a hint.
func TestEnsureInitializedOldResticMissingRepository(t *testing.T) {
	r, calls := scriptedRestic(t, map[string]string{"cat": `echo 'Fatal: unable to open config file: Stat: stat /repo/config: no such file or directory' >&2
echo 'Is there a repository at the following location?' >&2
echo '/repo' >&2
exit 1`})
	err := r.ensureInitialized(context.Background(), &Task{Repository: "/repo"}, nil)
	if err == nil || !strings.Contains(err.Error(), "unable to open config file") || !strings.Contains(err.Error(), "older than 0.17") {
		t.Fatalf("want restic's error with the old-restic hint, got %v", err)
	}
	if hasCall(calls(), "init") {
		t.Fatalf("init ran on an exit code other than 10: %v", calls())
	}
}

func TestEnsureInitializedReportsInitFailure(t *testing.T) {
	r, _ := scriptedRestic(t, map[string]string{"cat": missingRepo, "init": `echo 'Fatal: create repository at /x failed: permission denied' >&2
exit 1`})
	err := r.ensureInitialized(context.Background(), &Task{Repository: "/x"}, nil)
	if err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("want init's error, got %v", err)
	}
}

func TestBackupErrorCarriesResticsMessage(t *testing.T) {
	r, _ := scriptedRestic(t, map[string]string{"backup": `echo '/nonexistent does not exist, skipping' >&2
echo '{"message_type":"exit_error","code":1,"message":"Fatal: all source directories/files do not exist"}' >&2
exit 1`})
	a := &agent{runner: r}
	var logBuf logBuffer
	err := a.backupFiles(context.Background(), &Task{Paths: []string{"/nonexistent"}}, &TaskResult{}, logBuf.appendLine)
	if err == nil || err.Error() != "backup exited 1: all source directories/files do not exist" {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(logBuf.String(), "message_type") || !strings.Contains(logBuf.String(), "Fatal: all source") {
		t.Fatalf("log = %q", logBuf.String())
	}
}

func TestResticErrorLinesAreReadable(t *testing.T) {
	r, _ := scriptedRestic(t, map[string]string{"backup": `echo '{"message_type":"error","error":{"message":"open /secret: permission denied"},"during":"archival","item":"/secret"}' >&2
exit 3`})
	var logBuf logBuffer
	code, err := r.run(context.Background(), &Task{}, []string{"backup"}, nil, logBuf.appendLine)
	if err != nil || code != 3 {
		t.Fatalf("run = %d, %v", code, err)
	}
	if got := logBuf.String(); got != "error (archival): /secret: open /secret: permission denied\n" {
		t.Fatalf("log = %q", got)
	}
}

func TestResticRunsWithOneProgressLinePerSecond(t *testing.T) {
	r := fakeRestic(t, `env | grep '^RESTIC_PROGRESS_FPS=' >&2`, time.Second)
	var logBuf logBuffer
	if _, err := r.run(context.Background(), &Task{}, []string{"backup"}, nil, logBuf.appendLine); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(logBuf.String()) != "RESTIC_PROGRESS_FPS=1" {
		t.Fatalf("restic env: %q", logBuf.String())
	}
}

func TestBackupHonoursTheTimeLimit(t *testing.T) {
	srv := newResultServer(t, 200)
	r, calls := scriptedRestic(t, map[string]string{"backup": `echo '{"message_type":"status"}'
exec sleep 30`})
	a := &agent{baseURL: srv.URL, http: srv.Client(), runner: r}
	task := &Task{Type: "backup", TaskID: "run-tl", Paths: []string{"/data"},
		Options: &ResticOptions{TimeLimitSeconds: 1, Retention: &Retention{KeepLast: new(int)}}}
	started := time.Now()
	a.runBackup(context.Background(), task)
	if took := time.Since(started); took > 10*time.Second {
		t.Fatalf("the backup ran %v despite a 1 s limit", took)
	}
	got := srv.received()
	if len(got) != 1 || got[0].Status != "failed" || got[0].Error != "Time limit of 1 s exceeded." {
		t.Fatalf("result %+v", got)
	}
	if hasCall(calls(), "forget") {
		t.Fatalf("forget ran after the time limit: %v", calls())
	}
}

func TestSignalContextEndsOnSIGTERM(t *testing.T) {
	ctx, stop := signalContext(context.Background())
	defer stop()
	if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("SIGTERM did not end the agent's context")
	}
}
