package main

// Self-update: when the server advertises a newer agent version in a poll
// response, download the matching binary from the server, verify it runs and
// reports the expected version, atomically swap it in, and re-exec in place.
// This works for both systemd installs (writable /opt/amber-agent) and Docker
// (writable container layer, restart policy re-runs the swapped binary).

import (
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
)

// maybeSelfUpdate updates to `latest` when it is a strictly newer version than
// the running one. On a successful update it re-execs and never returns; any
// failure is logged and the current process keeps running (retried next poll).
func (a *agent) maybeSelfUpdate(latest string) {
	if latest == "" || !versionGreater(latest, agentVersion) {
		return
	}
	log.Printf("agent update available: %s -> %s", agentVersion, latest)
	if err := a.selfUpdate(latest); err != nil {
		log.Printf("self-update failed, staying on %s: %v", agentVersion, err)
	}
}

func (a *agent) selfUpdate(latest string) error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locating executable: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exePath); err == nil {
		exePath = resolved
	}

	url := fmt.Sprintf("%s/api/agents/binary/linux-%s", a.baseURL, runtime.GOARCH)
	// Download into the same directory so the final rename is atomic (same fs).
	tmp := exePath + ".new"
	if err := a.download(url, tmp); err != nil {
		return fmt.Errorf("downloading %s: %w", url, err)
	}
	defer os.Remove(tmp) // no-op once renamed away

	// Guard against a corrupt/partial download bricking the agent: the new
	// binary must run and report exactly the advertised version.
	out, err := exec.Command(tmp, "--version").Output()
	got := strings.TrimSpace(string(out))
	if err != nil || got != latest {
		return fmt.Errorf("version check failed (got %q want %q): %v", got, latest, err)
	}

	if err := os.Rename(tmp, exePath); err != nil {
		return fmt.Errorf("replacing binary: %w", err)
	}
	log.Printf("updated to %s, restarting", latest)

	// Replace the current process image with the new binary, preserving args
	// and environment. execve keeps the same PID, so systemd/Docker see no exit.
	if err := syscall.Exec(exePath, os.Args, os.Environ()); err != nil {
		// If exec somehow fails, fall back to a clean exit so the supervisor
		// (systemd Restart=always / Docker restart policy) starts us fresh.
		log.Printf("exec of new binary failed: %v; exiting for supervisor restart", err)
		os.Exit(0)
	}
	return nil
}

// download fetches url into dest as an executable file.
func (a *agent) download(url, dest string) error {
	resp, err := a.http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(f, resp.Body)
	closeErr := f.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

// versionGreater reports whether semantic version a is strictly newer than b.
// Unparseable components are treated as 0, so it degrades gracefully.
func versionGreater(a, b string) bool {
	pa, pb := parseVersion(a), parseVersion(b)
	for i := 0; i < len(pa); i++ {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func parseVersion(s string) [3]int {
	var v [3]int
	parts := strings.SplitN(strings.TrimPrefix(strings.TrimSpace(s), "v"), ".", 3)
	for i := 0; i < len(parts) && i < 3; i++ {
		n := 0
		fmt.Sscanf(parts[i], "%d", &n)
		v[i] = n
	}
	return v
}
