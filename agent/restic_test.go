package main

import "testing"

// indexOf returns the position of v in args, or -1.
func indexOf(args []string, v string) int {
	for i, a := range args {
		if a == v {
			return i
		}
	}
	return -1
}

// User-controlled positionals (paths, snapshot id) must sit after a `--`
// terminator so a value beginning with `-` cannot be parsed as a restic flag
// (e.g. --password-command=… which restic runs via the shell → RCE).
func TestBackupArgsPathsAfterTerminator(t *testing.T) {
	task := &Task{
		Paths:   []string{"--password-command=touch /pwn", "/data"},
		Options: &ResticOptions{Tags: []string{"nightly"}},
	}
	args := backupArgs(task)

	dd := indexOf(args, "--")
	if dd < 0 {
		t.Fatalf("backupArgs must contain a `--` terminator: %v", args)
	}
	for _, p := range task.Paths {
		if i := indexOf(args, p); i < dd {
			t.Fatalf("path %q at %d appears before terminator at %d: %v", p, i, dd, args)
		}
	}
	// The flag-looking path must never be the argument restic parses as a flag.
	if i := indexOf(args, "--password-command=touch /pwn"); i <= dd {
		t.Fatalf("injected path not placed after terminator: %v", args)
	}
}

func TestRestoreArgsSnapshotAfterTerminator(t *testing.T) {
	task := &Task{
		SnapshotID: "--password-command=touch /pwn",
		TargetPath: "/restore",
	}
	args := restoreArgs(task)

	dd := indexOf(args, "--")
	if dd < 0 {
		t.Fatalf("restoreArgs must contain a `--` terminator: %v", args)
	}
	if i := indexOf(args, task.SnapshotID); i < dd {
		t.Fatalf("snapshot id at %d appears before terminator at %d: %v", i, dd, args)
	}
}

func TestCheckArgs(t *testing.T) {
	cases := []struct {
		task Task
		want []string
	}{
		{Task{CheckLevel: "quick"}, []string{"check"}},
		{Task{CheckLevel: "full"}, []string{"check", "--read-data"}},
		{Task{CheckLevel: "rotating", CheckSubset: "3/12"}, []string{"check", "--read-data-subset=3/12"}},
		// A rotating task without a subset degrades to a structure check.
		{Task{CheckLevel: "rotating"}, []string{"check"}},
	}
	for _, c := range cases {
		got := checkArgs(&c.task)
		if len(got) != len(c.want) {
			t.Fatalf("checkArgs(%+v) = %v, want %v", c.task, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("checkArgs(%+v) = %v, want %v", c.task, got, c.want)
			}
		}
	}
}

func TestIsDamagedCheckOutput(t *testing.T) {
	if !isDamagedCheckOutput("pack abc contains 2 errors\nFatal: repository contains errors\n") {
		t.Fatal("damage report not recognized")
	}
	if isDamagedCheckOutput("Fatal: unable to create lock in backend: repository is already locked") {
		t.Fatal("lock failure mistaken for damage")
	}
}
