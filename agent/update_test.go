package main

import "testing"

func TestVersionGreater(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.2.0", "0.1.0", true},
		{"1.0.0", "0.9.9", true},
		{"0.1.1", "0.1.0", true},
		{"0.1.0", "0.1.0", false},
		{"0.1.0", "0.2.0", false},
		{"0.1.0", "1.0.0", false},
		{"v1.2.3", "1.2.2", true}, // tolerates a leading v
		{"", "0.1.0", false},      // unparseable -> 0.0.0
		{"1.2", "1.1.9", true},    // short versions
		{"bad", "0.0.1", false},   // non-numeric -> 0
	}
	for _, c := range cases {
		if got := versionGreater(c.a, c.b); got != c.want {
			t.Errorf("versionGreater(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestParseVersion(t *testing.T) {
	if v := parseVersion("1.2.3"); v != [3]int{1, 2, 3} {
		t.Errorf("parseVersion(1.2.3) = %v", v)
	}
	if v := parseVersion(" v0.10.0 "); v != [3]int{0, 10, 0} {
		t.Errorf("parseVersion(v0.10.0) = %v", v)
	}
}
