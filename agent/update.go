package main

// Self-update: when the server advertises a newer agent version in a poll
// response, download the matching binary from the server, verify it runs and
// reports the expected version, swap it in and restart. On Unix the agent
// re-execs in place (systemd / Docker see no exit); on Windows it exits and the
// service's recovery actions start the new binary.
//
// The same applies to a restic binary the agent manages itself (installed into
// the install directory from the server's bundle, see managedResticPath): it
// follows the server's bundled restic version.

import (
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// platformTarget is the os-arch name the server serves binaries under.
func platformTarget() string { return runtime.GOOS + "-" + runtime.GOARCH }

// updatesAllowed reports whether binaries may be downloaded and run. The agent
// runs as root / LocalSystem and would execute whatever a download yields; over
// plain HTTP a network attacker could substitute it, so only HTTPS (TLS
// authenticates the server and protects the binary in transit) is trusted.
func (a *agent) updatesAllowed(what, latest, current string) bool {
	if strings.HasPrefix(strings.ToLower(a.baseURL), "https://") {
		return true
	}
	log.Printf(
		"%s update %s available but auto-update is disabled over plain HTTP "+
			"(set an https:// server URL to enable); staying on %s",
		what, latest, current,
	)
	return false
}

// maybeSelfUpdate updates to `latest` when it is a strictly newer version than
// the running one. On a successful update it restarts and never returns; any
// failure is logged and the current process keeps running (retried next poll).
func (a *agent) maybeSelfUpdate(latest string) {
	if latest == "" || !versionGreater(latest, agentVersion) {
		return
	}
	if !a.updatesAllowed("agent", latest, agentVersion) {
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

	url := fmt.Sprintf("%s/api/agents/binary/%s", a.baseURL, platformTarget())
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

	if err := replaceExecutable(exePath, tmp); err != nil {
		return fmt.Errorf("replacing binary: %w", err)
	}
	log.Printf("updated to %s, restarting", latest)
	restartSelf(exePath)
	return nil
}

// managedResticPath is where the agent keeps a restic it installed itself (the
// server's bundled build, fetched by install.ps1 or install.sh).
func managedResticPath() string {
	return filepath.Join(installDir(), "restic"+exeSuffix)
}

// isManagedRestic reports whether the runner uses the agent-managed restic, as
// opposed to one the operator installed (system package, RESTIC_BINARY).
func (a *agent) isManagedRestic() bool {
	return a.runner != nil && sameFile(a.runner.binary, managedResticPath())
}

func sameFile(a, b string) bool {
	fa, errA := os.Stat(a)
	fb, errB := os.Stat(b)
	return errA == nil && errB == nil && os.SameFile(fa, fb)
}

// maybeUpdateRestic brings an agent-managed restic to the server's bundled
// version. A restic the operator installed is never touched. Only called while
// idle, so no restic process holds the file.
func (a *agent) maybeUpdateRestic(latest, current string) {
	if latest == "" || current == "" || current == "unknown" || latest == current || !a.isManagedRestic() {
		return
	}
	if !a.updatesAllowed("restic", latest, current) {
		return
	}
	log.Printf("restic update available: %s -> %s", current, latest)
	if err := a.updateRestic(latest); err != nil {
		log.Printf("restic update failed, staying on %s: %v", current, err)
		return
	}
	log.Printf("restic updated to %s", latest)
}

func (a *agent) updateRestic(latest string) error {
	dest := a.runner.binary
	url := fmt.Sprintf("%s/api/agents/restic/%s", a.baseURL, platformTarget())
	tmp := dest + ".new"
	if err := a.download(url, tmp); err != nil {
		return fmt.Errorf("downloading %s: %w", url, err)
	}
	defer os.Remove(tmp)
	if got := resticVersion(tmp); got != latest {
		return fmt.Errorf("version check failed (got %q want %q)", got, latest)
	}
	// restic is not running while the agent is idle, so a plain replace works
	// on every platform.
	return os.Rename(tmp, dest)
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
