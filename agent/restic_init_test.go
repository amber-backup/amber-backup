package main

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// Concurrent Proxmox guests share a repository; their ensureInitialized calls
// must leave exactly one usable repository (one key, readable config).
func TestEnsureInitializedConcurrent(t *testing.T) {
	restic := os.Getenv("AMBER_TEST_RESTIC")
	if restic == "" {
		t.Skip("AMBER_TEST_RESTIC not set")
	}
	tmp := t.TempDir()
	r := &resticRunner{binary: restic, cacheDir: filepath.Join(tmp, "cache"), stopGrace: defaultStopGrace}
	task := &Task{TaskID: "init-race", Repository: filepath.Join(tmp, "repo"), Password: "pw", Env: map[string]string{}}

	var wg sync.WaitGroup
	errs := make(chan error, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- r.ensureInitialized(context.Background(), task, nil)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("ensureInitialized: %v", err)
		}
	}
	keys, err := os.ReadDir(filepath.Join(tmp, "repo", "keys"))
	if err != nil || len(keys) != 1 {
		t.Fatalf("want exactly one key, got %d (%v)", len(keys), err)
	}
	if code, err := r.run(context.Background(), task, []string{"cat", "config"}, nil, nil); err != nil || code != 0 {
		t.Fatalf("cat config after concurrent init: code %d err %v", code, err)
	}
}
