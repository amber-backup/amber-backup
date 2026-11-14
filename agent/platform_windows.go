//go:build windows

package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
)

// exeSuffix is appended to executable names (restic, the agent itself).
const exeSuffix = ".exe"

// serviceName is the Windows service install.ps1 registers.
const serviceName = "AmberAgent"

// maxLogBytes is the size at which agent.log is rotated (on service start).
const maxLogBytes = 10 << 20

func defaultInstallDir() string {
	base := os.Getenv("ProgramData")
	if base == "" {
		base = `C:\ProgramData`
	}
	return filepath.Join(base, "AmberAgent")
}

// platformInit loads the agent's configuration file. A Windows service has no
// EnvironmentFile like systemd: install.ps1 writes agent.env into the install
// directory (readable by SYSTEM and Administrators only) and the agent reads it
// here. Variables already set in the environment win.
func platformInit() {
	path := os.Getenv("AMBER_ENV_FILE")
	if path == "" {
		path = filepath.Join(defaultInstallDir(), "agent.env")
	}
	if err := loadEnvFile(path); err != nil && !os.IsNotExist(err) {
		log.Printf("reading %s: %v", path, err)
	}
	// Left behind by the last self-update (a running .exe can't be deleted).
	if exe, err := os.Executable(); err == nil {
		os.Remove(exe + ".old")
	}
}

// runAsService runs the agent under the Service Control Manager when it was
// started by it, and reports false for an interactive start.
func runAsService(run func(ctx context.Context)) bool {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		return false
	}
	setupServiceLog()
	// A service has no console, but restic is stopped with a console
	// CTRL_BREAK, which only reaches processes sharing the sender's console.
	// Children inherit this (invisible, session 0) console.
	if err := allocConsole(); err != nil {
		log.Printf("cannot allocate a console, a cancel will kill restic: %v", err)
	}
	if err := svc.Run(serviceName, &service{run: run}); err != nil {
		log.Printf("service failed: %v", err)
	}
	return true
}

type service struct{ run func(ctx context.Context) }

// serviceStopWait bounds how long a stop waits for a running task to wind down
// (restic gets its grace period to release the repository lock).
const serviceStopWait = 40 * time.Second

func (s *service) Execute(_ []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		s.run(ctx)
		close(done)
	}()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				status <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending, WaitHint: uint32(serviceStopWait / time.Millisecond)}
				cancel()
				select {
				case <-done:
				case <-time.After(serviceStopWait):
				}
				return false, 0
			}
		case <-done:
			// The agent ended on its own: report a failure so the service's
			// recovery actions start it again.
			return false, 1
		}
	}
}

// setupServiceLog sends the log to agent.log in the install directory; a
// service has no stdout. The previous log is kept as agent.log.1.
func setupServiceLog() {
	dir := installDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	p := filepath.Join(dir, "agent.log")
	if fi, err := os.Stat(p); err == nil && fi.Size() > maxLogBytes {
		os.Rename(p, p+".1")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	log.SetOutput(f)
}

var (
	kernel32         = windows.NewLazySystemDLL("kernel32.dll")
	procAllocConsole = kernel32.NewProc("AllocConsole")
)

func allocConsole() error {
	if r, _, err := procAllocConsole.Call(); r == 0 {
		return err
	}
	return nil
}

// detectOS reads the edition and build from the registry, e.g.
// "Windows Server 2022 Datacenter (21H2, build 20348)".
func detectOS() string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE)
	if err != nil {
		return "windows"
	}
	defer k.Close()
	product, _, _ := k.GetStringValue("ProductName")
	display, _, _ := k.GetStringValue("DisplayVersion")
	build, _, _ := k.GetStringValue("CurrentBuildNumber")
	return formatWindowsOS(product, display, build)
}

// prepareResticCmd starts restic in a process group of its own, so a cancel
// can send it a CTRL_BREAK (which restic handles like SIGINT: it removes its
// repository lock) without hitting the agent. Windows cannot signal another
// process otherwise; if the event can't be sent, restic is killed.
func prepareResticCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	cmd.Cancel = func() error {
		if err := windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, uint32(cmd.Process.Pid)); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
}

// scriptCommand runs a job script without a shell. PowerShell scripts can't be
// executed directly, so they go through powershell.exe; .exe/.bat/.cmd run as
// they are.
func scriptCommand(ctx context.Context, path string) *exec.Cmd {
	if strings.EqualFold(filepath.Ext(path), ".ps1") {
		return exec.CommandContext(ctx, "powershell.exe",
			"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path)
	}
	return exec.CommandContext(ctx, path)
}

// tempBaseDir keeps per-run credential files in the install directory, whose
// ACL admits only SYSTEM and Administrators (set by install.ps1); the system
// temp directory is readable more widely on older Windows versions.
func tempBaseDir() string {
	dir := filepath.Join(installDir(), "tmp")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ""
	}
	return dir
}

func supportsFsSnapshot() bool { return true }

// replaceExecutable swaps in the new binary. Windows refuses to overwrite or
// delete a running .exe but allows renaming it, so the running one moves aside
// to .old (removed on the next start).
func replaceExecutable(exePath, newPath string) error {
	old := exePath + ".old"
	os.Remove(old)
	if err := os.Rename(exePath, old); err != nil {
		return err
	}
	if err := os.Rename(newPath, exePath); err != nil {
		os.Rename(old, exePath)
		return err
	}
	return nil
}

// restartSelf exits so the new binary is started: the service's recovery
// actions (set by install.ps1) restart it after an unexpected exit. Windows has
// no exec that keeps the process.
func restartSelf(string) {
	log.Printf("exiting so the service manager starts the new binary")
	os.Exit(1)
}
