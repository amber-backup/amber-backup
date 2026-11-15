package main

import (
	"encoding/json"
	"testing"
)

// The node's own configs are under /etc/pve/local (a symlink to
// nodes/<node>); /etc/pve/nodes/local does not exist.
func TestPveConfigPaths(t *testing.T) {
	cases := []struct{ got, want string }{
		{localConfigPath(pveTypeQemu, 100), "/etc/pve/local/qemu-server/100.conf"},
		{localConfigPath(pveTypeLXC, 101), "/etc/pve/local/lxc/101.conf"},
		{configPath("specht", pveTypeQemu, 102), "/etc/pve/nodes/specht/qemu-server/102.conf"},
		{configPath("*", pveTypeLXC, 103), "/etc/pve/nodes/*/lxc/103.conf"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("got %s, want %s", c.got, c.want)
		}
	}
}

// QEMU's nbd-server-start takes a SocketAddressLegacy ({type, data}).
func TestNbdServerStartArgs(t *testing.T) {
	got, _ := json.Marshal(nbdServerStartArgs("/tmp/x.sock"))
	want := `{"addr":{"data":{"path":"/tmp/x.sock"},"type":"unix"}}`
	if string(got) != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestEstimatedPercent(t *testing.T) {
	if p := estimatedPercent(50, 100); p != 0.5 {
		t.Errorf("half: %v", p)
	}
	if p := estimatedPercent(150, 100); p != 0.99 {
		t.Errorf("past the estimate must stay below 1: %v", p)
	}
}
