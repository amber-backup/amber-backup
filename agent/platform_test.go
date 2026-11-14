package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadEnvFileKeepsSetVariables(t *testing.T) {
	p := filepath.Join(t.TempDir(), "agent.env")
	content := "\ufeff# comment\nAMBER_TEST_A=from-file\n\nAMBER_TEST_B=b=c\nnot-a-line\nAMBER_TEST_C=file\n"
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AMBER_TEST_C", "env")
	os.Unsetenv("AMBER_TEST_A")
	os.Unsetenv("AMBER_TEST_B")
	t.Cleanup(func() { os.Unsetenv("AMBER_TEST_A"); os.Unsetenv("AMBER_TEST_B") })

	if err := loadEnvFile(p); err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]string{
		"AMBER_TEST_A": "from-file",
		"AMBER_TEST_B": "b=c", // only the first = separates key and value
		"AMBER_TEST_C": "env", // the environment wins over the file
	} {
		if got := os.Getenv(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
}

func TestFormatWindowsOS(t *testing.T) {
	cases := []struct{ product, display, build, want string }{
		{"Windows Server 2022 Datacenter", "21H2", "20348", "Windows Server 2022 Datacenter (21H2, build 20348)"},
		// Windows 11 still reports "Windows 10" as its product name.
		{"Windows 10 Pro", "23H2", "22631", "Windows 11 Pro (23H2, build 22631)"},
		{"Windows 10 Pro", "22H2", "19045", "Windows 10 Pro (22H2, build 19045)"},
		{"Windows Server 2016 Standard", "", "14393", "Windows Server 2016 Standard (build 14393)"},
		{"", "", "", "windows"},
	}
	for _, c := range cases {
		if got := formatWindowsOS(c.product, c.display, c.build); got != c.want {
			t.Errorf("formatWindowsOS(%q, %q, %q) = %q, want %q", c.product, c.display, c.build, got, c.want)
		}
	}
}

func TestBackupArgsIgnoresFsSnapshotOffWindows(t *testing.T) {
	args := backupArgs(&Task{Paths: []string{"/data"}, Options: &ResticOptions{UseFsSnapshot: true}})
	for _, a := range args {
		if a == "--use-fs-snapshot" && !supportsFsSnapshot() {
			t.Fatalf("--use-fs-snapshot passed on a platform without VSS: %v", args)
		}
	}
}
