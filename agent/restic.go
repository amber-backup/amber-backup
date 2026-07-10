package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// resticRunner executes restic on the agent host, mirroring the server executor.
type resticRunner struct {
	binary   string
	cacheDir string
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
	return &resticRunner{binary: bin, cacheDir: cache}
}

// prepareEnv builds the process environment and writes credential files.
func (r *resticRunner) prepareEnv(t *Task, workDir string) ([]string, error) {
	env := os.Environ()
	env = append(env,
		"RESTIC_REPOSITORY="+t.Repository,
		"RESTIC_PASSWORD="+t.Password,
		"RESTIC_CACHE_DIR="+r.cacheDir,
	)
	for k, v := range t.Env {
		env = append(env, k+"="+v)
	}
	for _, f := range t.CredentialFiles {
		fp := filepath.Join(workDir, f.Filename)
		if err := os.WriteFile(fp, []byte(f.Content), 0o600); err != nil {
			return nil, err
		}
		env = append(env, f.EnvVar+"="+fp)
	}
	return env, nil
}

// run executes restic with the given args, streaming JSON stdout lines to onLine.
func (r *resticRunner) run(t *Task, args []string, onLine func(map[string]any), onLog func(string)) (int, error) {
	workDir, err := os.MkdirTemp("", "amber-restic-")
	if err != nil {
		return -1, err
	}
	defer os.RemoveAll(workDir)

	env, err := r.prepareEnv(t, workDir)
	if err != nil {
		return -1, err
	}
	os.MkdirAll(r.cacheDir, 0o700)

	cmd := exec.Command(r.binary, args...)
	cmd.Env = env
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return -1, err
	}

	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 1024*1024), 8*1024*1024)
		for sc.Scan() {
			line := sc.Text()
			var obj map[string]any
			if json.Unmarshal([]byte(line), &obj) == nil {
				if onLine != nil {
					onLine(obj)
				}
			} else if onLog != nil {
				onLog(line)
			}
		}
	}()
	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			if onLog != nil {
				onLog(sc.Text())
			}
		}
	}()

	err = cmd.Wait()
	if exitErr, ok := err.(*exec.ExitError); ok {
		return exitErr.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

func (r *resticRunner) ensureInitialized(t *Task) error {
	code, err := r.run(t, []string{"cat", "config"}, nil, nil)
	if err != nil {
		return err
	}
	if code == 0 {
		return nil
	}
	code, err = r.run(t, []string{"init"}, nil, nil)
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
	args = append(args, t.Paths...)
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
	if ret.Prune {
		args = append(args, "--prune")
	}
	return args
}

func restoreArgs(t *Task) []string {
	args := []string{"restore", t.SnapshotID, "--json", "--target", t.TargetPath}
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
	return args
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
