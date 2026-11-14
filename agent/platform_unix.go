//go:build !windows

package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"strings"
	"syscall"
)

// exeSuffix is appended to executable names (restic, the agent itself).
const exeSuffix = ""

func defaultInstallDir() string { return "/opt/amber-agent" }

// platformInit prepares the process before anything else runs. Unix agents get
// their environment from systemd / Docker, so there is nothing to do.
func platformInit() {}

// runAsService runs the agent under the OS service manager when started by it.
// On Unix systemd and Docker run the agent as a plain process.
func runAsService(func(ctx context.Context)) bool { return false }

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

// prepareResticCmd makes a cancel interrupt restic with SIGINT, so it removes
// its repository lock before it exits.
func prepareResticCmd(cmd *exec.Cmd) {
	cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }
}

// scriptCommand runs a job script directly (no shell, no arguments).
func scriptCommand(ctx context.Context, path string) *exec.Cmd {
	return exec.CommandContext(ctx, path)
}

// tempBaseDir is where per-run credential files are written ("" = os default).
func tempBaseDir() string { return "" }

// supportsFsSnapshot reports whether restic can read from a filesystem
// snapshot (`--use-fs-snapshot`, Windows VSS only).
func supportsFsSnapshot() bool { return false }

// replaceExecutable atomically moves newPath over exePath (same directory).
func replaceExecutable(exePath, newPath string) error {
	return os.Rename(newPath, exePath)
}

// restartSelf replaces the current process image with the new binary,
// preserving args and environment. execve keeps the same PID, so systemd and
// Docker see no exit.
func restartSelf(exePath string) {
	if err := syscall.Exec(exePath, os.Args, os.Environ()); err != nil {
		// If exec somehow fails, fall back to a clean exit so the supervisor
		// (systemd Restart=always / Docker restart policy) starts us fresh.
		log.Printf("exec of new binary failed: %v; exiting for supervisor restart", err)
		os.Exit(0)
	}
}
