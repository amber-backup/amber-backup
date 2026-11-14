//go:build windows

package main

import "testing"

// ensureTestConsole gives the test process a console when it has none (CI
// runners start tests without one), as the service does at start: a
// CTRL_BREAK only reaches processes sharing the sender's console.
func ensureTestConsole(t *testing.T) {
	if err := allocConsole(); err != nil {
		t.Logf("AllocConsole: %v (a console is probably attached already)", err)
	}
}
