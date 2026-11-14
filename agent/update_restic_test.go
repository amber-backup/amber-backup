//go:build !windows

package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func fakeResticScript(version string) []byte {
	return []byte("#!/bin/sh\necho \"restic " + version + " compiled with go1.27.3 on linux/amd64\"\n")
}

// managedRestic installs a fake restic as the agent-managed one.
func managedRestic(t *testing.T, version string) string {
	t.Helper()
	t.Setenv("INSTALL_DIR", t.TempDir())
	p := managedResticPath()
	if err := os.WriteFile(p, fakeResticScript(version), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func resticServer(t *testing.T, version string, hits *int32) *httptest.Server {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(hits, 1)
		if r.URL.Path != "/api/agents/restic/"+platformTarget() {
			http.NotFound(w, r)
			return
		}
		w.Write(fakeResticScript(version))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestMaybeUpdateResticReplacesManagedBinary(t *testing.T) {
	bin := managedRestic(t, "0.18.0")
	var hits int32
	srv := resticServer(t, "0.19.1", &hits)
	a := &agent{baseURL: srv.URL, http: srv.Client(), runner: &resticRunner{binary: bin}}

	a.maybeUpdateRestic("0.19.1", resticVersion(bin))

	if got := resticVersion(bin); got != "0.19.1" {
		t.Fatalf("restic version after update = %q, want 0.19.1", got)
	}
	if _, err := os.Stat(bin + ".new"); !os.IsNotExist(err) {
		t.Fatalf("temporary download left behind: %v", err)
	}
}

func TestMaybeUpdateResticRejectsWrongVersion(t *testing.T) {
	bin := managedRestic(t, "0.18.0")
	var hits int32
	srv := resticServer(t, "0.17.0", &hits) // serves something other than advertised
	a := &agent{baseURL: srv.URL, http: srv.Client(), runner: &resticRunner{binary: bin}}

	a.maybeUpdateRestic("0.19.1", "0.18.0")

	if got := resticVersion(bin); got != "0.18.0" {
		t.Fatalf("restic replaced by a binary of the wrong version: %q", got)
	}
}

func TestMaybeUpdateResticLeavesOperatorResticAlone(t *testing.T) {
	managedRestic(t, "0.18.0")
	own := filepath.Join(t.TempDir(), "restic")
	if err := os.WriteFile(own, fakeResticScript("0.18.0"), 0o755); err != nil {
		t.Fatal(err)
	}
	var hits int32
	srv := resticServer(t, "0.19.1", &hits)
	a := &agent{baseURL: srv.URL, http: srv.Client(), runner: &resticRunner{binary: own}}

	a.maybeUpdateRestic("0.19.1", "0.18.0")

	if hits != 0 || resticVersion(own) != "0.18.0" {
		t.Fatalf("operator-installed restic was updated (hits=%d)", hits)
	}
}

func TestMaybeUpdateResticSkipsOverHTTP(t *testing.T) {
	bin := managedRestic(t, "0.18.0")
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
	}))
	defer srv.Close()
	a := &agent{baseURL: srv.URL, http: srv.Client(), runner: &resticRunner{binary: bin}}

	a.maybeUpdateRestic("0.19.1", "0.18.0")

	if hits != 0 {
		t.Fatalf("restic downloaded over plain HTTP")
	}
}
