package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"syscall"
)

// resolvedRepo mirrors the server's /repositories/:id/resolve payload, which is
// the same shape the Go agent receives for a task.
type resolvedRepo struct {
	Repository      string            `json:"repository"`
	Password        string            `json:"password"`
	Env             map[string]string `json:"env"`
	CredentialFiles []credentialFile  `json:"credentialFiles"`
	// Global restic options prepended before the subcommand (e.g. the SFTP
	// -o sftp.command=...). May reference credential files via a
	// {{credentialFile:<filename>}} placeholder.
	ExtraArgs []string `json:"extraArgs"`
}

type credentialFile struct {
	EnvVar   string `json:"envVar"`
	Filename string `json:"filename"`
	Content  string `json:"content"`
}

// exitCodeError carries a child process exit code so main can exit with it
// without printing an error (restic uses non-zero codes meaningfully).
type exitCodeError struct{ code int }

func (e *exitCodeError) Error() string {
	return fmt.Sprintf("restic exited with code %d", e.code)
}

var credentialFileRefRE = regexp.MustCompile(`\{\{credentialFile:([^}]+)\}\}`)

// substituteCredentialPaths replaces {{credentialFile:NAME}} tokens with the
// on-disk path of that credential file (mirrors the server and agent).
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

// parseResolved re-decodes the generic JSON value returned by the client into a
// typed resolvedRepo.
func parseResolved(v any) (*resolvedRepo, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var r resolvedRepo
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, fmt.Errorf("unexpected resolve response: %w", err)
	}
	if r.Repository == "" {
		return nil, fmt.Errorf("resolve response missing repository")
	}
	return &r, nil
}

// resticBinary is the restic executable to invoke (override with RESTIC_BINARY).
func resticBinary() string {
	if b := os.Getenv("RESTIC_BINARY"); b != "" {
		return b
	}
	return "restic"
}

// execRestic runs restic against the resolved repository with the given
// passthrough args, wiring the caller's stdio through so interactive commands
// (mount, prompts, progress) work. Credential files live in a temp dir for the
// lifetime of the process and are removed on return. On a non-zero restic exit
// it returns an *exitCodeError carrying the code.
func execRestic(r *resolvedRepo, resticArgs []string) error {
	workDir, err := os.MkdirTemp("", "ambb-restic-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(workDir)

	env := os.Environ()
	env = append(env,
		"RESTIC_REPOSITORY="+r.Repository,
		"RESTIC_PASSWORD="+r.Password,
	)
	for k, v := range r.Env {
		env = append(env, k+"="+v)
	}
	paths := make(map[string]string, len(r.CredentialFiles))
	for _, f := range r.CredentialFiles {
		fp := filepath.Join(workDir, f.Filename)
		if err := os.WriteFile(fp, []byte(f.Content), 0o600); err != nil {
			return err
		}
		paths[f.Filename] = fp
		// Files referenced only by path (e.g. an SSH key) carry no env var.
		if f.EnvVar != "" {
			env = append(env, f.EnvVar+"="+fp)
		}
	}

	// Global options (e.g. sftp.command) must precede the subcommand.
	extraArgs := substituteCredentialPaths(r.ExtraArgs, paths)
	fullArgs := append(append([]string{}, extraArgs...), resticArgs...)

	cmd := exec.Command(resticBinary(), fullArgs...)
	cmd.Env = env
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start %q (is restic on PATH?): %w", resticBinary(), err)
	}

	// Forward interrupts to restic so long-running commands like `mount` unmount
	// cleanly instead of leaving a stale FUSE mount behind.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		for s := range sigCh {
			_ = cmd.Process.Signal(s)
		}
	}()

	err = cmd.Wait()
	signal.Stop(sigCh)
	close(sigCh)
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return &exitCodeError{code: exit.ExitCode()}
		}
		return err
	}
	return nil
}
