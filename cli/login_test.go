package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

func TestNormalizeServerURL(t *testing.T) {
	cases := map[string]string{
		"amber.farkopf.dev":                 "https://amber.farkopf.dev",
		"https://Amber.Example.com/":        "https://amber.example.com",
		"http://localhost:3000/backup/?x#y": "http://localhost:3000/backup",
	}
	for in, want := range cases {
		if got, err := normalizeServerURL(in); err != nil || got != want {
			t.Errorf("normalizeServerURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "ftp://host", "https://user:pw@host", "https://"} {
		if _, err := normalizeServerURL(bad); err == nil {
			t.Errorf("normalizeServerURL(%q) should fail", bad)
		}
	}
}

func TestIsLoopbackURL(t *testing.T) {
	for url, want := range map[string]bool{
		"http://localhost:3000":   true,
		"http://127.0.0.1":        true,
		"http://[::1]:3000":       true,
		"http://amber.example":    false,
		"http://localhost.evil.x": false,
	} {
		if got := isLoopbackURL(url); got != want {
			t.Errorf("isLoopbackURL(%s) = %v", url, got)
		}
	}
}

func TestSanitizeClientName(t *testing.T) {
	if got := sanitizeClientName("my<host>\n"); got != "my-host-" {
		t.Errorf("sanitizeClientName = %q", got)
	}
	if got := sanitizeClientName(strings.Repeat("a", 100)); len(got) != 64 {
		t.Errorf("name not truncated: %d", len(got))
	}
}

func TestLoginRefusesPlainHTTPToRemoteServer(t *testing.T) {
	t.Setenv("AMBB_CONFIG_DIR", t.TempDir())
	err := runLogin(&Config{}, "http://amber.example.com")
	if err == nil || !strings.Contains(err.Error(), "plain HTTP") {
		t.Fatalf("err = %v, want plain HTTP refusal", err)
	}
}

func TestCredentialStoreIsPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permissions")
	}
	dir := t.TempDir()
	t.Setenv("AMBB_CONFIG_DIR", dir)
	store := &credentialStore{Servers: map[string]storedLogin{"https://a": {APIKey: "ak_x"}}}
	if err := store.save(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "credentials.json")
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o, want 600", info.Mode().Perm())
	}
	if _, err := loadCredentials(); err != nil {
		t.Fatal(err)
	}
	os.Chmod(path, 0o644)
	if _, err := loadCredentials(); err == nil {
		t.Fatal("a group/world-readable credentials file must be refused")
	}
}

func TestStoredKeyIsOnlyUsedForItsServer(t *testing.T) {
	t.Setenv("AMBB_CONFIG_DIR", t.TempDir())
	store := &credentialStore{
		Current: "https://a.example",
		Servers: map[string]storedLogin{"https://a.example": {APIKey: "ak_a"}},
	}
	if err := store.save(); err != nil {
		t.Fatal(err)
	}

	cfg := &Config{}
	if err := cfg.requireCredentials(); err != nil || cfg.URL != "https://a.example" || cfg.APIKey != "ak_a" {
		t.Fatalf("current login: %+v, %v", cfg, err)
	}
	cfg = &Config{URL: "https://b.example"}
	if err := cfg.requireCredentials(); err == nil || cfg.APIKey != "" {
		t.Fatalf("key for a.example leaked to b.example: %+v", cfg)
	}
}

func TestLoginAndLogoutFlow(t *testing.T) {
	t.Setenv("AMBB_CONFIG_DIR", t.TempDir())
	var polls, revoked atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "POST /api/auth/device/code":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["clientName"] != "test-box" || r.Header.Get("Authorization") != "" {
				http.Error(w, "bad request", 400)
				return
			}
			w.Write([]byte(`{"deviceCode":"secret-device-code-0123456789","userCode":"BCDF-GHJK","expiresIn":60,"interval":1}`))
		case "POST /api/auth/device/token":
			if polls.Add(1) < 2 {
				w.Write([]byte(`{"status":"pending"}`))
				return
			}
			w.Write([]byte(`{"status":"approved","apiKey":"ak_issued","email":"a@example.com","access":"read","expiresAt":null}`))
		case "DELETE /api/auth/device/key":
			if r.Header.Get("Authorization") != "Bearer ak_issued" {
				http.Error(w, "unauthorized", 401)
				return
			}
			revoked.Add(1)
			w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	name := "test-box"
	cfg := &Config{Flags: CommandFlags{Name: &name, NoBrowser: true}}
	if err := runLogin(cfg, srv.URL); err != nil {
		t.Fatalf("login: %v", err)
	}
	store, err := loadCredentials()
	if err != nil {
		t.Fatal(err)
	}
	if store.Current != srv.URL || store.Servers[srv.URL].APIKey != "ak_issued" {
		t.Fatalf("store after login = %+v", store)
	}

	if err := runLogout(&Config{}, ""); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if revoked.Load() != 1 {
		t.Fatal("logout did not revoke the key on the server")
	}
	store, _ = loadCredentials()
	if len(store.Servers) != 0 || store.Current != "" {
		t.Fatalf("store after logout = %+v", store)
	}
}
