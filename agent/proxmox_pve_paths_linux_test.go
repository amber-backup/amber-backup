package main

import "testing"

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
