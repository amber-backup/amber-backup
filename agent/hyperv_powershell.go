package main

// The real Hyper-V backend: embedded PowerShell scripts (agent/hyperv/*.ps1)
// run through powershell.exe. Each script gets its input as JSON on stdin
// ({"conn": …, "args": …}) and answers with one line
// "AMBER-RESULT:{"ok":true,"data":…}" (or ok=false with an error). For a
// remote host the scripts run their Hyper-V part through Invoke-Command with
// the stored credential, and the agent reads the host's files over its admin
// shares (\\host\D$\…).

import (
	"bufio"
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

//go:embed hyperv/*.ps1
var hypervScripts embed.FS

const resultMarker = "AMBER-RESULT:"

type powershellHyperv struct {
	exe     string
	timeout time.Duration
}

// newPowershellHyperv is available on every Windows agent: a proxy for remote
// hosts needs no Hyper-V role of its own. A local host without the Hyper-V
// module fails its inventory with PowerShell's own error.
func newPowershellHyperv() hypervBackend {
	if runtime.GOOS != "windows" {
		return nil
	}
	return &powershellHyperv{exe: "powershell.exe", timeout: 2 * time.Hour}
}

func (p *powershellHyperv) Name() string { return "powershell" }

type psResult struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data"`
	Error string          `json:"error"`
}

// call runs common.ps1 + the named script and decodes its data into out.
func (p *powershellHyperv) call(ctx context.Context, script string, conn HypervConnection, args any, out any) error {
	common, err := hypervScripts.ReadFile("hyperv/common.ps1")
	if err != nil {
		return err
	}
	body, err := hypervScripts.ReadFile("hyperv/" + script + ".ps1")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(tempBaseDir(), "amber-hv-*.ps1")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	// A BOM makes Windows PowerShell 5.1 read the script as UTF-8.
	f.Write([]byte("\ufeff"))
	f.Write(common)
	f.Write([]byte("\r\n"))
	f.Write(body)
	if err := f.Close(); err != nil {
		return err
	}

	input, err := json.Marshal(map[string]any{"conn": conn, "args": args})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, p.exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", f.Name())
	cmd.Stdin = bytes.NewReader(input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	runErr := cmd.Run()
	res, perr := parsePSResult(stdout.Bytes())
	if perr != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(stdout.String())
		}
		if runErr != nil {
			return fmt.Errorf("%s: %v: %s", script, runErr, truncate(msg, 2000))
		}
		return fmt.Errorf("%s: %v: %s", script, perr, truncate(msg, 2000))
	}
	if !res.OK {
		return errors.New(res.Error)
	}
	if out != nil && len(res.Data) > 0 {
		if err := json.Unmarshal(res.Data, out); err != nil {
			return fmt.Errorf("%s: unexpected output: %w", script, err)
		}
	}
	return nil
}

// parsePSResult finds the result line; anything else a cmdlet prints is noise.
func parsePSResult(stdout []byte) (*psResult, error) {
	var line string
	sc := bufio.NewScanner(bytes.NewReader(stdout))
	sc.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for sc.Scan() {
		if t := strings.TrimSpace(sc.Text()); strings.HasPrefix(t, resultMarker) {
			line = strings.TrimPrefix(t, resultMarker)
		}
	}
	if line == "" {
		return nil, errors.New("no result")
	}
	var r psResult
	if err := json.Unmarshal([]byte(line), &r); err != nil {
		return nil, err
	}
	return &r, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func (p *powershellHyperv) Connect(ctx context.Context, conn HypervConnection) (func(), error) {
	if conn.Mode != "remote" {
		return func() {}, nil
	}
	if err := p.call(ctx, "connect", conn, nil, nil); err != nil {
		return nil, err
	}
	return func() {
		cctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		p.call(cctx, "disconnect", conn, nil, nil)
	}, nil
}

func (p *powershellHyperv) Inventory(ctx context.Context, conn HypervConnection) (*HypervInventory, error) {
	var inv HypervInventory
	if err := p.call(ctx, "inventory", conn, nil, &inv); err != nil {
		return nil, err
	}
	return &inv, nil
}

func (p *powershellHyperv) PrepareBackup(ctx context.Context, conn HypervConnection, vmID, checkpoint, mode string) (*vmBackupSet, error) {
	var set vmBackupSet
	err := p.call(ctx, "prepare", conn, map[string]any{
		"vmId": vmID, "checkpoint": checkpoint, "mode": mode,
		// Configuration files are only readable consistently through a VSS
		// snapshot of a local host.
		"includeConfig": conn.Mode != "remote",
	}, &set)
	if err != nil {
		return nil, err
	}
	return &set, nil
}

func (p *powershellHyperv) RemoveCheckpoints(ctx context.Context, conn HypervConnection, vmID string, names []string) error {
	return p.call(ctx, "remove-checkpoints", conn, map[string]any{"vmId": vmID, "names": names}, nil)
}

func (p *powershellHyperv) RegisterVM(ctx context.Context, conn HypervConnection, req registerRequest) (*registeredVM, error) {
	var vm registeredVM
	if err := p.call(ctx, "register", conn, req, &vm); err != nil {
		return nil, err
	}
	return &vm, nil
}

func (p *powershellHyperv) RemoveVM(ctx context.Context, conn HypervConnection, vmID string) error {
	return p.call(ctx, "remove-vm", conn, map[string]any{"vmId": vmID}, nil)
}

// AgentPath reaches a remote host's file through its administrative share:
// D:\VMs\a.vhdx → \\host\D$\VMs\a.vhdx.
func (p *powershellHyperv) AgentPath(conn HypervConnection, hostPath string) string {
	return agentPathFor(conn, hostPath)
}

func agentPathFor(conn HypervConnection, hostPath string) string {
	if conn.Mode != "remote" || len(hostPath) < 2 || hostPath[1] != ':' {
		return hostPath
	}
	rest := strings.TrimLeft(hostPath[2:], `\`)
	return `\\` + conn.Address + `\` + strings.ToUpper(hostPath[:1]) + `$\` + rest
}
