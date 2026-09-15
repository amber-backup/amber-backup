package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIntegrityPayloadCronEnablesAndKeepsStoredFields(t *testing.T) {
	current := map[string]any{"enabled": false, "level": "rotating", "subsetParts": float64(12)}
	flags := &CommandFlags{Cron: strPtr("0 4 * * 0")}

	body, err := buildIntegrityPayload(flags, current)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got, want := encode(t, body), `{"cronExpr":"0 4 * * 0","enabled":true,"level":"rotating","subsetParts":12}`; got != want {
		t.Errorf("payload = %s, want %s", got, want)
	}
}

func TestIntegrityPayloadDisableKeepsSchedule(t *testing.T) {
	current := map[string]any{"enabled": true, "cronExpr": "0 4 * * 0", "level": "full"}

	body, err := buildIntegrityPayload(&CommandFlags{Disable: true}, current)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got, want := encode(t, body), `{"cronExpr":"0 4 * * 0","enabled":false,"level":"full"}`; got != want {
		t.Errorf("payload = %s, want %s", got, want)
	}
}

func TestIntegrityPayloadDropsPartsWhenLeavingRotating(t *testing.T) {
	current := map[string]any{"enabled": true, "cronExpr": "@weekly", "level": "rotating", "subsetParts": float64(8)}

	body, err := buildIntegrityPayload(&CommandFlags{Level: strPtr("quick")}, current)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := body["subsetParts"]; ok {
		t.Errorf("payload = %v, want no subsetParts", body)
	}
}

func TestIntegrityPayloadDefaultsToQuickOnEmptyConfig(t *testing.T) {
	body, err := buildIntegrityPayload(&CommandFlags{Cron: strPtr("@daily")}, map[string]any{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got, want := encode(t, body), `{"cronExpr":"@daily","enabled":true,"level":"quick"}`; got != want {
		t.Errorf("payload = %s, want %s", got, want)
	}
}

func TestIntegrityPayloadRejectsInvalidFlags(t *testing.T) {
	stored := map[string]any{"enabled": false, "level": "quick"}
	for name, flags := range map[string]*CommandFlags{
		"enable and disable":     {Enable: true, Disable: true},
		"cron with disable":      {Cron: strPtr("@daily"), Disable: true},
		"empty cron":             {Cron: strPtr("  ")},
		"enable without cron":    {Enable: true},
		"unknown level":          {Level: strPtr("deep")},
		"parts out of range":     {Level: strPtr("rotating"), Parts: strPtr("1")},
		"parts not a number":     {Level: strPtr("rotating"), Parts: strPtr("ten")},
		"parts without rotating": {Parts: strPtr("4")},
	} {
		if _, err := buildIntegrityPayload(flags, stored); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestCheckFlagsRejectedElsewhere(t *testing.T) {
	cases := []struct {
		flags   CommandFlags
		allowed []string
	}{
		{CommandFlags{Level: strPtr("full")}, []string{"job-check", "job-integrity"}},
		{CommandFlags{Wait: true}, []string{"job-check"}},
		{CommandFlags{Cron: strPtr("@daily")}, []string{"job-integrity"}},
		{CommandFlags{Parts: strPtr("4")}, []string{"job-integrity"}},
	}
	for _, c := range cases {
		for _, cmd := range []string{"", "credentials", "agent-create", "job-check", "job-integrity"} {
			err := c.flags.rejectFlagsExcept(cmd)
			allowed := strings.Contains(strings.Join(c.allowed, ","), cmd) && cmd != ""
			if allowed && err != nil {
				t.Errorf("%+v under %q: unexpected error %v", c.flags, cmd, err)
			}
			if !allowed && err == nil {
				t.Errorf("%+v under %q: expected an error", c.flags, cmd)
			}
		}
	}
}

func TestParseArgsCollectsCheckFlags(t *testing.T) {
	cfg := &Config{}
	positionals, err := parseArgs(
		[]string{"job", "integrity", "daily", "--cron", "0 4 * * 0", "--level=rotating", "--parts", "6", "--enable"},
		cfg,
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Join(positionals, " ") != "job integrity daily" {
		t.Errorf("positionals = %v", positionals)
	}
	f := cfg.Flags
	if f.Cron == nil || *f.Cron != "0 4 * * 0" || f.Level == nil || *f.Level != "rotating" ||
		f.Parts == nil || *f.Parts != "6" || !f.Enable {
		t.Errorf("flags = %+v", f)
	}
}

func TestCheckVerdict(t *testing.T) {
	cases := []struct {
		run    map[string]any
		passed bool
		want   string
	}{
		{
			map[string]any{"status": "success", "check_info": map[string]any{"level": "rotating", "part": float64(3), "parts": float64(12)}},
			true, "rotating, part 3 of 12",
		},
		{
			map[string]any{"status": "failed", "error": "Integrity errors found", "check_info": map[string]any{"level": "full", "damaged": true}},
			false, "found damage",
		},
		{map[string]any{"status": "failed", "error": "repository locked"}, false, "repository locked"},
		{map[string]any{"status": "cancelled"}, false, "cancelled"},
	}
	for _, c := range cases {
		passed, summary := checkVerdict(c.run)
		if passed != c.passed || !strings.Contains(summary, c.want) {
			t.Errorf("checkVerdict(%v) = %v, %q; want %v, containing %q", c.run, passed, summary, c.passed, c.want)
		}
	}
}

func TestWaitForRunPollsUntilFinishedAndRetriesServerErrors(t *testing.T) {
	responses := []struct {
		code int
		body string
	}{
		{200, `{"status":"queued"}`},
		{503, `{"message":"restarting"}`},
		{200, `{"status":"running"}`},
		{200, `{"status":"success","check_info":{"level":"quick"}}`},
	}
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runs/run-1" {
			t.Errorf("path = %s", r.URL.Path)
		}
		resp := responses[min(calls, len(responses)-1)]
		calls++
		w.WriteHeader(resp.code)
		_, _ = w.Write([]byte(resp.body))
	}))
	defer srv.Close()

	client := NewClient(&Config{URL: srv.URL, APIKey: "ak_test"})
	run, err := waitForRun(client, "run-1", time.Second, func(time.Duration) {})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if run["status"] != "success" || calls != 4 {
		t.Errorf("run = %v after %d calls", run, calls)
	}
}

func TestWaitForRunStopsOnClientError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"Run not found"}`))
	}))
	defer srv.Close()

	client := NewClient(&Config{URL: srv.URL, APIKey: "ak_test"})
	if _, err := waitForRun(client, "run-1", time.Second, func(time.Duration) {}); err == nil {
		t.Fatal("expected an error for a missing run")
	}
}
