package main

// Parsing of Proxmox VE configuration files (guest configs, storage.cfg,
// corosync.conf) and the decisions that only depend on them: which disks a
// guest has, which backup method `auto` picks. Portable, so it is tested on
// every platform; the real backend (proxmox_pve_linux.go) and the mock both
// use it.

import (
	"bufio"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// pveConfig is a guest config: the current section's keys plus the names of
// its snapshot sections ([name]); [PENDING] and [special:…] are ignored.
type pveConfig struct {
	Keys      map[string]string
	Order     []string // keys in file order
	Snapshots []string
	// Raw lines of the current section (for configs stored with a backup).
	Lines []string
}

// parsePveConfig reads a qemu-server or lxc config.
// ASSUMPTION(pve): configs are `key: value` lines; sections `[name]` follow the
// current config and hold snapshots, `[PENDING]` and `[special:cloudinit]`.
func parsePveConfig(text string) *pveConfig {
	c := &pveConfig{Keys: map[string]string{}}
	section := ""
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, "\r")
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			section = strings.TrimSuffix(strings.TrimPrefix(trimmed, "["), "]")
			if section != "PENDING" && !strings.HasPrefix(section, "special:") {
				c.Snapshots = append(c.Snapshots, section)
			}
			continue
		}
		if section != "" {
			continue
		}
		c.Lines = append(c.Lines, line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		k, v, ok := strings.Cut(trimmed, ":")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		if _, dup := c.Keys[k]; !dup {
			c.Order = append(c.Order, k)
		}
		// lxc.* raw keys (e.g. lxc.idmap) may repeat; keep them joined by newlines.
		if prev, dup := c.Keys[k]; dup && strings.HasPrefix(k, "lxc.") {
			c.Keys[k] = prev + "\n" + strings.TrimSpace(v)
		} else {
			c.Keys[k] = strings.TrimSpace(v)
		}
	}
	return c
}

// currentConfigText is the config without snapshot sections, without the
// `parent:` / `lock:` lines — what a backup stores.
func (c *pveConfig) currentConfigText() string {
	var out []string
	for _, l := range c.Lines {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "parent:") || strings.HasPrefix(t, "lock:") {
			continue
		}
		out = append(out, l)
	}
	for len(out) > 0 && strings.TrimSpace(out[len(out)-1]) == "" {
		out = out[:len(out)-1]
	}
	return strings.Join(out, "\n") + "\n"
}

func (c *pveConfig) flag(key string) bool {
	v := c.Keys[key]
	// `agent: 1` or `agent: enabled=1,fstrim_cloned_disks=1`
	first := strings.SplitN(v, ",", 2)[0]
	first = strings.TrimPrefix(first, "enabled=")
	return first == "1"
}

// propList splits "vol,key=value,key2=value2" into the volume and its options.
func propList(v string) (string, map[string]string) {
	parts := strings.Split(v, ",")
	opts := map[string]string{}
	vol := ""
	for i, p := range parts {
		k, val, ok := strings.Cut(p, "=")
		if !ok {
			if i == 0 {
				vol = p
			}
			continue
		}
		if i == 0 && (k == "volume" || k == "file") {
			vol = val
			continue
		}
		opts[k] = val
	}
	return vol, opts
}

var (
	qemuDiskKeyRE = regexp.MustCompile(`^(ide|sata|scsi|virtio)\d+$|^efidisk0$|^tpmstate0$`)
	lxcMountKeyRE = regexp.MustCompile(`^rootfs$|^mp\d+$`)
)

// parseSize reads PVE size strings: 32G, 512M, 4M, 528K, 1T, or plain bytes.
func parseSize(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	mult := int64(1)
	switch s[len(s)-1] {
	case 'K', 'k':
		mult = 1 << 10
	case 'M', 'm':
		mult = 1 << 20
	case 'G', 'g':
		mult = 1 << 30
	case 'T', 't':
		mult = 1 << 40
	}
	if mult != 1 {
		s = s[:len(s)-1]
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return int64(f * float64(mult))
}

// guestDisks lists the volumes of a guest that a backup could contain, in
// config-key order. CD-ROMs, passthrough devices without a storage and
// unused volumes are left out; backup=0 is kept with Backup=false.
func guestDisks(typ string, c *pveConfig) []ProxmoxGuestDisk {
	var out []ProxmoxGuestDisk
	keys := append([]string(nil), c.Order...)
	sort.Strings(keys)
	for _, k := range keys {
		v := c.Keys[k]
		if typ == pveTypeQemu && !qemuDiskKeyRE.MatchString(k) {
			continue
		}
		if typ == pveTypeLXC && !lxcMountKeyRE.MatchString(k) {
			continue
		}
		vol, opts := propList(v)
		if vol == "" || vol == "none" || opts["media"] == "cdrom" {
			continue
		}
		storage, volname, ok := strings.Cut(vol, ":")
		d := ProxmoxGuestDisk{Key: k, Volid: vol, SizeBytes: parseSize(opts["size"]), Backup: true}
		if ok && !strings.HasPrefix(vol, "/") {
			d.Storage = storage
			d.Format = volumeFormat(volname, opts["format"])
		} else {
			// A host path (passthrough device or, for a CT, a bind mount).
			d.Storage = ""
		}
		if typ == pveTypeLXC {
			if k == "rootfs" {
				d.MountPath = "/"
			} else {
				d.MountPath = opts["mp"]
				// ASSUMPTION(pve): CT mount points are backed up only with backup=1 (vzdump's rule).
				d.Backup = opts["backup"] == "1"
			}
		} else if opts["backup"] == "0" {
			d.Backup = false
		}
		out = append(out, d)
	}
	return out
}

func volumeFormat(volname, explicit string) string {
	if explicit != "" {
		return explicit
	}
	switch {
	case strings.HasSuffix(volname, ".qcow2"):
		return "qcow2"
	case strings.HasSuffix(volname, ".vmdk"):
		return "vmdk"
	case strings.HasSuffix(volname, ".raw"):
		return "raw"
	case strings.Contains(volname, "subvol-"):
		return "subvol"
	}
	return "raw"
}

// pveStorageCfg is one storage of /etc/pve/storage.cfg.
type pveStorageCfg struct {
	ID    string
	Type  string
	Props map[string]string
}

func (s *pveStorageCfg) prop(k string) string { return s.Props[k] }

// parseStorageCfg reads /etc/pve/storage.cfg:
//
//	zfspool: local-zfs
//		pool rpool/data
//		content images,rootdir
func parseStorageCfg(text string) map[string]*pveStorageCfg {
	out := map[string]*pveStorageCfg{}
	var cur *pveStorageCfg
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		line := sc.Text()
		if strings.TrimSpace(line) == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		if line[0] != ' ' && line[0] != '\t' {
			typ, id, ok := strings.Cut(line, ":")
			if !ok {
				cur = nil
				continue
			}
			cur = &pveStorageCfg{ID: strings.TrimSpace(id), Type: strings.TrimSpace(typ), Props: map[string]string{}}
			out[cur.ID] = cur
			continue
		}
		if cur == nil {
			continue
		}
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		cur.Props[f[0]] = strings.Join(f[1:], " ")
		if len(f) == 1 {
			cur.Props[f[0]] = "1" // flags like `sparse`
		}
	}
	return out
}

// ASSUMPTION(pve): these storage types are "always shared" in PVE.
var sharedStorageTypes = map[string]bool{"rbd": true, "cephfs": true, "nfs": true, "cifs": true, "glusterfs": true, "iscsi": true, "iscsidirect": true, "pbs": true}

// storageView turns a storage.cfg entry into the inventory shape.
func storageView(s *pveStorageCfg) ProxmoxStorage {
	v := ProxmoxStorage{ID: s.ID, Type: s.Type, Content: splitList(s.prop("content")), Nodes: splitList(s.prop("nodes"))}
	v.Shared = sharedStorageTypes[s.Type] || s.prop("shared") == "1"
	v.Snapshots = snapshotStorage(s.Type, "")
	if v.Content == nil {
		v.Content = []string{}
	}
	if v.Nodes == nil {
		v.Nodes = []string{}
	}
	return v
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ';' || r == ' ' }) {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// snapshotStorage tells whether Amber can read a snapshot of a volume of this
// storage type and format (block / files methods).
// directReadable reports whether a stopped VM's volume can be read as a
// raw image without activating anything: a raw file on a file storage.
func directReadable(storageType, format string) bool {
	switch storageType {
	case "dir", "nfs", "cifs", "glusterfs":
		return format == "raw"
	}
	return false
}

func snapshotStorage(storageType, format string) bool {
	switch storageType {
	case "zfspool", "lvmthin", "rbd":
		return true
	case "dir", "nfs", "cifs", "glusterfs":
		// Only qcow2 images have (internal) snapshots there.
		return format == "qcow2"
	}
	return false
}

// resolveMethod picks how a guest is backed up: the job's choice ("vzdump"
// forces the fallback), otherwise block (VMs) / files (CTs) when every
// backed-up volume is on a storage Amber can snapshot. The reason explains a
// fallback.
func resolveMethod(g *ProxmoxGuest, choice string, storages map[string]*pveStorageCfg) (string, string) {
	if choice == pveMethodVzdump {
		return pveMethodVzdump, "the job uses vzdump"
	}
	if g.Template {
		return pveMethodVzdump, "templates can't be snapshotted"
	}
	snapMethod := pveMethodBlock
	if g.Type == pveTypeLXC {
		snapMethod = pveMethodFiles
	}
	hasDisk := false
	for _, d := range g.Disks {
		if !d.Backup {
			continue
		}
		hasDisk = true
		if d.Storage == "" {
			if g.Type == pveTypeLXC {
				// Bind mounts are never backed up (vzdump skips them too).
				continue
			}
			return pveMethodVzdump, fmt.Sprintf("disk %s is not on a PVE storage", d.Key)
		}
		st := storages[d.Storage]
		if st == nil {
			return pveMethodVzdump, fmt.Sprintf("storage %s of %s is unknown", d.Storage, d.Key)
		}
		if g.Type == pveTypeLXC && st.Type != "zfspool" && st.Type != "lvmthin" && st.Type != "rbd" {
			return pveMethodVzdump, fmt.Sprintf("%s is on storage %s (%s), which Amber can't snapshot and mount", d.Key, d.Storage, st.Type)
		}
		if !snapshotStorage(st.Type, d.Format) {
			// A running VM is read through a fleecing view instead, a stopped
			// one's raw image file as it is (locked).
			if g.Type == pveTypeQemu && (g.Status == "running" || directReadable(st.Type, d.Format)) {
				continue
			}
			return pveMethodVzdump, fmt.Sprintf("%s is on storage %s (%s, %s), which has no snapshots", d.Key, d.Storage, st.Type, d.Format)
		}
	}
	if !hasDisk {
		return pveMethodVzdump, "the guest has no disk to back up"
	}
	return snapMethod, ""
}

// staleAmberSnapshots are the snapshots a crashed Amber run left behind.
func staleAmberSnapshots(c *pveConfig) []string {
	out := []string{}
	for _, s := range c.Snapshots {
		if strings.HasPrefix(s, pveSnapshotPrefix) {
			out = append(out, s)
		}
	}
	return out
}

// corosyncClusterName reads `cluster_name` from the totem section of
// /etc/pve/corosync.conf; "" on a standalone node.
func corosyncClusterName(text string) string {
	for _, line := range strings.Split(text, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), ":")
		if ok && strings.TrimSpace(k) == "cluster_name" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// idMapEntry maps container ids [CT, CT+Count) to host ids [Host, Host+Count).
type idMapEntry struct {
	Kind  string `json:"kind"` // u | g
	CT    int64  `json:"ct"`
	Host  int64  `json:"host"`
	Count int64  `json:"count"`
}

// ASSUMPTION(pve): unprivileged CTs without lxc.idmap lines map 0..65535 to
// 100000..165535 (PVE's default subuid/subgid range).
var defaultIDMap = []idMapEntry{
	{Kind: "u", CT: 0, Host: 100000, Count: 65536},
	{Kind: "g", CT: 0, Host: 100000, Count: 65536},
}

// ctIDMap is the id mapping of a container; nil for a privileged one.
func ctIDMap(c *pveConfig) []idMapEntry {
	if c.Keys["unprivileged"] != "1" {
		return nil
	}
	raw := c.Keys["lxc.idmap"]
	if raw == "" {
		return defaultIDMap
	}
	var out []idMapEntry
	for _, l := range strings.Split(raw, "\n") {
		f := strings.Fields(strings.TrimPrefix(strings.TrimSpace(l), "="))
		if len(f) != 4 {
			continue
		}
		ct, e1 := strconv.ParseInt(f[1], 10, 64)
		host, e2 := strconv.ParseInt(f[2], 10, 64)
		n, e3 := strconv.ParseInt(f[3], 10, 64)
		if e1 != nil || e2 != nil || e3 != nil {
			continue
		}
		out = append(out, idMapEntry{Kind: f[0], CT: ct, Host: host, Count: n})
	}
	return out
}

// hostToCT maps a host-side id to the container's view (65534 when unmapped).
func hostToCT(m []idMapEntry, kind string, id int64) int64 {
	if m == nil {
		return id
	}
	for _, e := range m {
		if e.Kind == kind && id >= e.Host && id < e.Host+e.Count {
			return e.CT + id - e.Host
		}
	}
	return 65534
}

// tagValue makes a value safe for a restic tag (no commas, no spaces).
func tagValue(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == ',' || r == ' ' || r == '\t' || r == '\n' {
			return '_'
		}
		return r
	}, s)
	return s
}

func pveGuestTag(vmid int) string      { return fmt.Sprintf("pve-guest:%d", vmid) }
func pveClusterTag(slug string) string { return "pve-cluster:" + tagValue(slug) }
func pveResticHost(slug string) string { return "pve-" + tagValue(slug) }

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
