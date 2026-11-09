package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"testing"
	"time"
)

// The test binary doubles as a fake restic (AMBER_FAKE_RESTIC=1): it prints a
// status line, then waits for an interrupt — SIGINT on Unix, CTRL_BREAK on
// Windows, both arrive as os.Interrupt like in restic — and reports it.
func TestMain(m *testing.M) {
	if os.Getenv("AMBER_FAKE_RESTIC") == "1" {
		fakeResticMain()
		return
	}
	os.Exit(m.Run())
}

func fakeResticMain() {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	fmt.Println(`{"message_type":"status"}`)
	select {
	case <-sig:
		fmt.Println("interrupted gracefully")
		os.Exit(130)
	case <-time.After(60 * time.Second):
		os.Exit(1)
	}
}

// A cancel must reach restic as an interrupt (so it can remove its repository
// lock), not as a kill — on every platform, Windows included.
func TestCancelInterruptsResticGracefully(t *testing.T) {
	ensureTestConsole(t)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	r := &resticRunner{binary: exe, cacheDir: t.TempDir(), stopGrace: 20 * time.Second}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var logBuf strings.Builder
	started := time.Now()
	code, err := r.run(ctx, &Task{Env: map[string]string{"AMBER_FAKE_RESTIC": "1"}}, []string{"backup"},
		func(map[string]any) { cancel() },
		func(s string) { logBuf.WriteString(s + "\n") })

	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !strings.Contains(logBuf.String(), "interrupted gracefully") || code != 130 {
		t.Fatalf("restic was not interrupted gracefully (exit %d, log %q)", code, logBuf.String())
	}
	if took := time.Since(started); took > 10*time.Second {
		t.Fatalf("cancel took %v; the interrupt did not arrive", took)
	}
}
