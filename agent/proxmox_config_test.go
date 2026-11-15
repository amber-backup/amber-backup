package main

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

const testQemuConf = `boot: order=scsi0
cores: 4
memory: 4096
name: web01
agent: enabled=1,fstrim_cloned_disks=1
efidisk0: local-lvm:vm-100-disk-1,efitype=4m,size=4M
scsi0: local-lvm:vm-100-disk-0,iothread=1,size=32G
scsi1: nas:100/vm-100-disk-2.qcow2,backup=0,size=1T
ide2: local:iso/debian.iso,media=cdrom,size=600M
virtio0: /dev/disk/by-id/ata-XYZ,size=500G
unused0: local-lvm:vm-100-disk-9
lock: backup
parent: before-upgrade

[before-upgrade]
cores: 2
scsi0: local-lvm:vm-100-disk-0,size=32G

[amber-abc123]
cores: 4

[PENDING]
memory: 8192
`

func TestParsePveConfig(t *testing.T) {
	c := parsePveConfig(testQemuConf)
	if c.Keys["cores"] != "4" || c.Keys["name"] != "web01" {
		t.Fatalf("current section not read: %v", c.Keys)
	}
	if !reflect.DeepEqual(c.Snapshots, []string{"before-upgrade", "amber-abc123"}) {
		t.Fatalf("snapshots %v", c.Snapshots)
	}
	if !c.flag("agent") {
		t.Fatal("agent flag")
	}
	if got := staleAmberSnapshots(c); !reflect.DeepEqual(got, []string{"amber-abc123"}) {
		t.Fatalf("stale %v", got)
	}
	cur := c.currentConfigText()
	if strings.Contains(cur, "lock:") || strings.Contains(cur, "parent:") || strings.Contains(cur, "[") {
		t.Fatalf("current config keeps lock/parent/sections:\n%s", cur)
	}
}

func TestGuestDisksQemu(t *testing.T) {
	disks := guestDisks(pveTypeQemu, parsePveConfig(testQemuConf))
	byKey := map[string]ProxmoxGuestDisk{}
	for _, d := range disks {
		byKey[d.Key] = d
	}
	if _, ok := byKey["ide2"]; ok {
		t.Fatal("cdrom must be skipped")
	}
	if _, ok := byKey["unused0"]; ok {
		t.Fatal("unused volumes are not disks")
	}
	if d := byKey["scsi0"]; d.Storage != "local-lvm" || d.SizeBytes != 32<<30 || !d.Backup || d.Format != "raw" {
		t.Fatalf("scsi0 %+v", d)
	}
	if d := byKey["scsi1"]; d.Backup || d.Format != "qcow2" || d.SizeBytes != 1<<40 {
		t.Fatalf("scsi1 %+v", d)
	}
	if d := byKey["virtio0"]; d.Storage != "" {
		t.Fatalf("passthrough disk has no storage: %+v", d)
	}
	if d := byKey["efidisk0"]; d.SizeBytes != 4<<20 {
		t.Fatalf("efidisk %+v", d)
	}
}

func TestGuestDisksLXCAndIDMap(t *testing.T) {
	conf := `hostname: ct1
unprivileged: 1
rootfs: local-zfs:subvol-101-disk-0,size=8G
mp0: local-zfs:subvol-101-disk-1,mp=/data,backup=1,size=2G
mp1: local-zfs:subvol-101-disk-2,mp=/cache,size=2G
mp2: /mnt/host,mp=/host
lxc.idmap: u 0 100000 1000
lxc.idmap: g 0 100000 65536
lxc.idmap: u 1000 1000 1
lxc.idmap: u 1001 101001 64535
`
	c := parsePveConfig(conf)
	disks := guestDisks(pveTypeLXC, c)
	got := map[string]ProxmoxGuestDisk{}
	for _, d := range disks {
		got[d.Key] = d
	}
	if got["rootfs"].MountPath != "/" || !got["rootfs"].Backup || got["rootfs"].Format != "subvol" {
		t.Fatalf("rootfs %+v", got["rootfs"])
	}
	if !got["mp0"].Backup || got["mp0"].MountPath != "/data" {
		t.Fatalf("mp0 %+v", got["mp0"])
	}
	if got["mp1"].Backup {
		t.Fatal("mp1 has no backup=1")
	}
	if got["mp2"].Storage != "" {
		t.Fatal("bind mount has no storage")
	}
	m := ctIDMap(c)
	if len(m) != 4 {
		t.Fatalf("idmap %v", m)
	}
	for _, tc := range []struct {
		kind string
		host int64
		ct   int64
	}{{"u", 100000, 0}, {"u", 1000, 1000}, {"u", 101500, 1500}, {"g", 100033, 33}, {"u", 5, 65534}} {
		if got := hostToCT(m, tc.kind, tc.host); got != tc.ct {
			t.Errorf("hostToCT(%s %d) = %d, want %d", tc.kind, tc.host, got, tc.ct)
		}
	}
	if ctIDMap(parsePveConfig("rootfs: a:b\n")) != nil {
		t.Fatal("privileged CT has no idmap")
	}
	if !reflect.DeepEqual(ctIDMap(parsePveConfig("unprivileged: 1\n")), defaultIDMap) {
		t.Fatal("default idmap")
	}
}

const testStorageCfg = `dir: local
	path /var/lib/vz
	content iso,vztmpl,backup

lvmthin: local-lvm
	thinpool data
	vgname pve
	content rootdir,images

zfspool: tank
	pool tank/vm
	nodes pve1,pve2
	sparse

lvm: thick
	vgname san
	shared 1

nfs: nas
	export /pve
	path /mnt/pve/nas
	server 10.0.0.1
	content images
`

func TestParseStorageCfg(t *testing.T) {
	st := parseStorageCfg(testStorageCfg)
	if len(st) != 5 {
		t.Fatalf("storages %v", st)
	}
	if st["local-lvm"].Type != "lvmthin" || st["local-lvm"].prop("vgname") != "pve" {
		t.Fatalf("local-lvm %+v", st["local-lvm"])
	}
	if st["tank"].prop("sparse") != "1" {
		t.Fatal("flag props")
	}
	v := storageView(st["tank"])
	if !reflect.DeepEqual(v.Nodes, []string{"pve1", "pve2"}) || !v.Snapshots || v.Shared {
		t.Fatalf("tank view %+v", v)
	}
	if v := storageView(st["thick"]); !v.Shared || v.Snapshots {
		t.Fatalf("thick %+v", v)
	}
	if v := storageView(st["nas"]); !v.Shared {
		t.Fatalf("nfs is shared: %+v", v)
	}
}

func TestResolveMethod(t *testing.T) {
	st := parseStorageCfg(testStorageCfg)
	vm := func(disks ...ProxmoxGuestDisk) *ProxmoxGuest {
		return &ProxmoxGuest{Type: pveTypeQemu, Disks: disks}
	}
	lvm := ProxmoxGuestDisk{Key: "scsi0", Storage: "local-lvm", Format: "raw", Backup: true}
	qcow := ProxmoxGuestDisk{Key: "scsi1", Storage: "nas", Format: "qcow2", Backup: true}
	rawNFS := ProxmoxGuestDisk{Key: "scsi2", Storage: "nas", Format: "raw", Backup: true}
	thick := ProxmoxGuestDisk{Key: "scsi3", Storage: "thick", Format: "raw", Backup: true}

	if m, _ := resolveMethod(vm(lvm, qcow), "auto", st); m != pveMethodBlock {
		t.Fatalf("lvm-thin + qcow2 → block, got %s", m)
	}
	if m, _ := resolveMethod(vm(lvm, rawNFS), "auto", st); m != pveMethodBlock {
		t.Fatalf("stopped VM, raw file on nfs → block (read as it is), got %s", m)
	}
	if m, r := resolveMethod(vm(lvm, thick), "auto", st); m != pveMethodVzdump || !strings.Contains(r, "scsi3") {
		t.Fatalf("stopped VM on thick lvm → vzdump (%s, %s)", m, r)
	}
	running := vm(lvm, thick, rawNFS)
	running.Status = "running"
	if m, _ := resolveMethod(running, "auto", st); m != pveMethodBlock {
		t.Fatalf("running VM without snapshots → block (fleecing), got %s", m)
	}
	off := thick
	off.Backup = false
	if m, _ := resolveMethod(vm(lvm, off), "auto", st); m != pveMethodBlock {
		t.Fatal("backup=0 disks don't matter")
	}
	if m, _ := resolveMethod(vm(lvm), "vzdump", st); m != pveMethodVzdump {
		t.Fatal("job choice wins")
	}
	tpl := vm(lvm)
	tpl.Template = true
	if m, _ := resolveMethod(tpl, "auto", st); m != pveMethodVzdump {
		t.Fatal("templates → vzdump")
	}
	ct := &ProxmoxGuest{Type: pveTypeLXC, Disks: []ProxmoxGuestDisk{
		{Key: "rootfs", Storage: "tank", Format: "subvol", Backup: true, MountPath: "/"},
		{Key: "mp0", Storage: "", Backup: true, MountPath: "/host"},
	}}
	if m, _ := resolveMethod(ct, "auto", st); m != pveMethodFiles {
		t.Fatalf("zfs CT with a bind mount → files, got %s", m)
	}
	ct.Disks[0].Storage = "nas"
	if m, _ := resolveMethod(ct, "auto", st); m != pveMethodVzdump {
		t.Fatal("CT on nfs → vzdump")
	}
}

func TestMiscHelpers(t *testing.T) {
	for in, want := range map[string]int64{"32G": 32 << 30, "512M": 512 << 20, "528K": 528 << 10, "1T": 1 << 40, "4096": 4096, "1.5G": 3 << 29, "": 0} {
		if got := parseSize(in); got != want {
			t.Errorf("parseSize(%q) = %d, want %d", in, got, want)
		}
	}
	if corosyncClusterName("totem {\n  cluster_name: prod-a\n  config_version: 3\n}\n") != "prod-a" {
		t.Fatal("cluster name")
	}
	if tagValue("a,b c") != "a_b_c" || pveResticHost("x,y") != "pve-x_y" {
		t.Fatal("tag sanitizing")
	}
	if pveGuestTag(105) != "pve-guest:105" || pveClusterTag("lab") != "pve-cluster:lab" {
		t.Fatal("tags")
	}
	args := proxmoxForgetArgs("lab")(&Retention{KeepLast: ptr(3)})
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--host pve-lab") || !strings.Contains(joined, "--tag amber-proxmox,pve-cluster:lab") ||
		!strings.Contains(joined, "--group-by host,tags") {
		t.Fatalf("forget args %v", args)
	}
	_ = time.Now
}

func ptr[T any](v T) *T { return &v }
