package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// Over a plain-HTTP server URL the agent must not download/exec an update
// binary, since a network attacker could substitute it (the agent runs as root).
func TestMaybeSelfUpdateSkipsOverHTTP(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	a := &agent{baseURL: srv.URL, http: srv.Client()} // srv.URL is http://
	a.maybeSelfUpdate("999.0.0")                       // far newer than the built-in version

	if got := atomic.LoadInt32(&hits); got != 0 {
		t.Fatalf("expected no download over HTTP, but server was hit %d time(s)", got)
	}
}
