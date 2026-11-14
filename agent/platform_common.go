package main

// Platform helpers without OS-specific dependencies, kept here so they are
// built (and tested) on every platform.

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// loadEnvFile sets KEY=VALUE lines of path that are not set yet. Blank lines
// and lines starting with # are skipped; values are taken verbatim.
func loadEnvFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(strings.TrimPrefix(sc.Text(), "\ufeff"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		k = strings.TrimSpace(k)
		if !ok || k == "" {
			continue
		}
		if _, set := os.LookupEnv(k); !set {
			os.Setenv(k, v)
		}
	}
	return sc.Err()
}

// formatWindowsOS renders the registry values. Windows 11 still reports
// "Windows 10" as its ProductName; the build number (22000+) tells them apart.
func formatWindowsOS(product, display, build string) string {
	if product == "" {
		return "windows"
	}
	var n int
	fmt.Sscanf(build, "%d", &n)
	if n >= 22000 && strings.HasPrefix(product, "Windows 10") {
		product = "Windows 11" + strings.TrimPrefix(product, "Windows 10")
	}
	var details []string
	if display != "" {
		details = append(details, display)
	}
	if build != "" {
		details = append(details, "build "+build)
	}
	if len(details) == 0 {
		return product
	}
	return product + " (" + strings.Join(details, ", ") + ")"
}
