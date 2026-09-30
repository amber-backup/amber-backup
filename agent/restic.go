package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var credentialFileRefRE = regexp.MustCompile(`\{\{credentialFile:([^}]+)\}\}`)

// substituteCredentialPaths replaces {{credentialFile:NAME}} tokens in restic
// args with the on-disk path of that credential file (mirrors the server).
func substituteCredentialPaths(args []string, paths map[string]string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		out[i] = credentialFileRefRE.ReplaceAllStringFunc(a, func(m string) string {
			name := credentialFileRefRE.FindStringSubmatch(m)[1]
			if p, ok := paths[name]; ok {
				return p
			}
			return m
		})
	}
	return out
}

// defaultStopGrace is how long restic may take to wind down after a cancel
// (SIGINT: it removes its repository lock) before it is killed.
const defaultStopGrace = 30 * time.Second

// resticRunner executes restic on the agent host, mirroring the server executor.
type resticRunner struct {
	binary    string
	cacheDir  string
	stopGrace time.Duration
}

func newResticRunner() *resticRunner {
	bin := os.Getenv("RESTIC_BINARY")
	if bin == "" {
		bin = "restic"
	}
	cache := os.Getenv("RESTIC_CACHE_DIR")
	if cache == "" {
		cache = filepath.Join(os.TempDir(), "amber-restic-cache")
	}
	return &resticRunner{binary: bin, cacheDir: cache, stopGrace: defaultStopGrace}
}

// prepareEnv builds the process environment and writes credential files. It
// returns the env plus a map of credential filename -> on-disk path, used to
// resolve {{credentialFile:...}} placeholders in ExtraArgs.
func (r *resticRunner) prepareEnv(t *Task, workDir string) ([]string, map[string]string, error) {
	env := os.Environ()
	env = append(env,
		"RESTIC_REPOSITORY="+t.Repository,
		"RESTIC_PASSWORD="+t.Password,
		"RESTIC_CACHE_DIR="+r.cacheDir,
	)
	for k, v := range t.Env {
		env = append(env, k+"="+v)
	}
	paths := make(map[string]string, len(t.CredentialFiles))
	for _, f := range t.CredentialFiles {
		fp := filepath.Join(workDir, f.Filename)
		if err := os.WriteFile(fp, []byte(f.Content), 0o600); err != nil {
			return nil, nil, err
		}
		paths[f.Filename] = fp
		// Files referenced only by path (e.g. an SSH key) carry no env var.
		if f.EnvVar != "" {
			env = append(env, f.EnvVar+"="+fp)
		}
	}
	return env, paths, nil
}

// run executes restic with the given args, streaming JSON stdout lines to onLine.
// Cancelling ctx interrupts restic (SIGINT, so it releases its repository lock)
// and kills it if it hasn't exited after stopGrace; callers tell a cancel apart
// from a failure by ctx.Err().
func (r *resticRunner) run(ctx context.Context, t *Task, args []string, onLine func(map[string]any), onLog func(string)) (int, error) {
	workDir, err := os.MkdirTemp("", "amber-restic-")
	if err != nil {
		return -1, err
	}
	defer os.RemoveAll(workDir)

	env, credPaths, err := r.prepareEnv(t, workDir)
	if err != nil {
		return -1, err
	}
	os.MkdirAll(r.cacheDir, 0o700)

	// Global options (e.g. sftp.command) must precede the subcommand.
	extraArgs := substituteCredentialPaths(t.ExtraArgs, credPaths)
	fullArgs := append(append([]string{}, extraArgs...), args...)
	cmd := exec.CommandContext(ctx, r.binary, fullArgs...)
	cmd.Env = env
	cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }
	cmd.WaitDelay = r.stopGrace
	// Output goes through in-process pipes rather than StdoutPipe: exec then
	// copies it itself, so Wait returns only once all output (e.g. restic's
	// final "Fatal: …" line) is through, and WaitDelay also bounds a child
	// process (such as sftp's ssh) that keeps the stream open after a kill.
	stdout, stdoutW := io.Pipe()
	stderr, stderrW := io.Pipe()
	cmd.Stdout = stdoutW
	cmd.Stderr = stderrW
	if err := cmd.Start(); err != nil {
		return -1, err
	}

	var readers sync.WaitGroup
	readers.Add(2)
	// Both streams feed the same log; callers append to a plain strings.Builder.
	var logMu sync.Mutex
	logLine := func(line string) {
		if onLog == nil {
			return
		}
		logMu.Lock()
		defer logMu.Unlock()
		onLog(line)
	}
	go func() {
		defer readers.Done()
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 1024*1024), 8*1024*1024)
		for sc.Scan() {
			line := sc.Text()
			var obj map[string]any
			if json.Unmarshal([]byte(line), &obj) == nil {
				if onLine != nil {
					onLine(obj)
				}
			} else {
				logLine(line)
			}
		}
		// A scanner stops at an over-long line; keep draining so restic can't block.
		io.Copy(io.Discard, stdout)
	}()
	go func() {
		defer readers.Done()
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			logLine(sc.Text())
		}
		io.Copy(io.Discard, stderr)
	}()

	err = cmd.Wait()
	stdoutW.Close()
	stderrW.Close()
	readers.Wait()
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

func (r *resticRunner) ensureInitialized(ctx context.Context, t *Task) error {
	code, err := r.run(ctx, t, []string{"cat", "config"}, nil, nil)
	if err != nil {
		return err
	}
	if code == 0 {
		return nil
	}
	code, err = r.run(ctx, t, []string{"init"}, nil, nil)
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("restic init failed")
	}
	return nil
}

func backupArgs(t *Task) []string {
	args := []string{"backup", "--json"}
	o := t.Options
	if o != nil {
		for _, tag := range o.Tags {
			args = append(args, "--tag", tag)
		}
		for _, e := range o.Exclude {
			args = append(args, "--exclude", e)
		}
		for _, e := range o.IExclude {
			args = append(args, "--iexclude", e)
		}
		if o.OneFileSystem {
			args = append(args, "--one-file-system")
		}
		if o.ExcludeCaches {
			args = append(args, "--exclude-caches")
		}
		if o.ExcludeLargerThan != "" {
			args = append(args, "--exclude-larger-than", o.ExcludeLargerThan)
		}
		if o.Compression != "" {
			args = append(args, "--compression", o.Compression)
		}
		if o.ReadConcurrency > 0 {
			args = append(args, "--read-concurrency", strconv.Itoa(o.ReadConcurrency))
		}
	}
	// `--` terminates option parsing: a source path beginning with `-` is then
	// treated as a path, never as a restic flag (e.g. --password-command=…).
	args = append(args, "--")
	args = append(args, t.Paths...)
	return args
}

func forgetArgs(ret *Retention) []string {
	args := []string{"forget", "--json"}
	addInt := func(flag string, v *int) {
		if v != nil {
			args = append(args, flag, strconv.Itoa(*v))
		}
	}
	addInt("--keep-last", ret.KeepLast)
	addInt("--keep-hourly", ret.KeepHourly)
	addInt("--keep-daily", ret.KeepDaily)
	addInt("--keep-weekly", ret.KeepWeekly)
	addInt("--keep-monthly", ret.KeepMonthly)
	addInt("--keep-yearly", ret.KeepYearly)
	if ret.KeepWithin != "" {
		args = append(args, "--keep-within", ret.KeepWithin)
	}
	for _, tag := range ret.KeepTags {
		args = append(args, "--keep-tag", tag)
	}
	// Never --prune here: the prune runs afterwards as a separate step with
	// its own timing and outcome (see runPrune).
	return args
}

func restoreArgs(t *Task) []string {
	args := []string{"restore", "--json", "--target", t.TargetPath}
	includes := t.IncludedPaths
	o := t.RestoreOptions
	if o != nil {
		if len(includes) == 0 {
			includes = o.Include
		}
		for _, e := range o.Exclude {
			args = append(args, "--exclude", e)
		}
		if o.Overwrite != "" {
			args = append(args, "--overwrite", o.Overwrite)
		}
		if o.Verify {
			args = append(args, "--verify")
		}
		if o.Delete {
			args = append(args, "--delete")
		}
		if o.DryRun {
			args = append(args, "--dry-run")
		}
	}
	for _, inc := range includes {
		args = append(args, "--include", inc)
	}
	// `--` terminates option parsing so a snapshot id beginning with `-` cannot
	// be interpreted as a restic flag.
	args = append(args, "--", t.SnapshotID)
	return args
}

// checkArgs builds `restic check` arguments for the task's level (mirrors the
// server's checkArgs). The subset comes from the server as "part/parts".
func checkArgs(t *Task) []string {
	switch t.CheckLevel {
	case "full":
		return []string{"check", "--read-data"}
	case "rotating":
		if t.CheckSubset != "" {
			return []string{"check", "--read-data-subset=" + t.CheckSubset}
		}
	}
	return []string{"check"}
}

// statsArgs reads the repository's stored footprint (mirrors the server's
// stats()). raw-data mode also reports the snapshot count, so one command
// yields both figures.
func statsArgs() []string {
	return []string{"stats", "--json", "--no-lock", "--mode", "raw-data"}
}

// repoStatsFrom picks the figures out of `restic stats --json` output.
func repoStatsFrom(msg map[string]any) *RepoStats {
	num := func(key string) int64 {
		v, _ := msg[key].(float64)
		return int64(v)
	}
	return &RepoStats{SizeBytes: num("total_size"), SnapshotCount: num("snapshots_count")}
}

// jsonNum reads a numeric field of restic's JSON output; restic omits zero
// values, so an absent field reads as 0.
func jsonNum(msg map[string]any, key string) float64 {
	v, _ := msg[key].(float64)
	return v
}

// restoreProgress maps a `restic restore --json` status line to the progress
// fields a backup reports (mirrors the server's ResticService.restore).
// Skipped files count as done, or `--overwrite if-changed` never reaches 100 %.
func restoreProgress(msg map[string]any) map[string]any {
	return map[string]any{
		"percentDone": jsonNum(msg, "percent_done"),
		"bytesDone":   jsonNum(msg, "bytes_restored") + jsonNum(msg, "bytes_skipped"),
		"totalBytes":  jsonNum(msg, "total_bytes"),
		"filesDone":   jsonNum(msg, "files_restored") + jsonNum(msg, "files_skipped"),
		"totalFiles":  jsonNum(msg, "total_files"),
	}
}

// restoreSummaryToStats maps the restore summary to the final stats (mirrors
// the server): totals processed, and the progress fields at 100 %.
func restoreSummaryToStats(msg map[string]any) map[string]any {
	files := jsonNum(msg, "total_files")
	bytes := jsonNum(msg, "total_bytes")
	return map[string]any{
		"totalFilesProcessed": files,
		"totalBytesProcessed": bytes,
		"percentDone":         1,
		"bytesDone":           bytes,
		"totalBytes":          bytes,
		"filesDone":           files,
		"totalFiles":          files,
	}
}

// isDamagedCheckOutput tells a check that found errors apart from one that
// could not run: restic ends the former with "Fatal: repository contains errors".
func isDamagedCheckOutput(output string) bool {
	return strings.Contains(strings.ToLower(output), "repository contains errors")
}

func hasRetention(ret *Retention) bool {
	if ret == nil {
		return false
	}
	return ret.KeepLast != nil || ret.KeepHourly != nil || ret.KeepDaily != nil ||
		ret.KeepWeekly != nil || ret.KeepMonthly != nil || ret.KeepYearly != nil ||
		ret.KeepWithin != "" || len(ret.KeepTags) > 0
}

func resticVersion(binary string) string {
	out, err := exec.Command(binary, "version").Output()
	if err != nil {
		return "unknown"
	}
	fields := strings.Fields(string(out))
	if len(fields) >= 2 {
		return fields[1]
	}
	return "unknown"
}
