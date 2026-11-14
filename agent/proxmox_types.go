package main

// Proxmox VE wire types — mirror server/src/proxmox/proxmox.contract.ts
// (JSON names identical). Keep both in sync.

// ProxmoxAgentInfo is announced in every poll (PollRequest.Proxmox).
type ProxmoxAgentInfo struct {
	// sha256 hex of /etc/pve/pve-root-ca.pem — shared by every node of a cluster.
	ClusterID   string  `json:"clusterId"`
	ClusterName *string `json:"clusterName"`
	Node        string  `json:"node"`
	PveVersion  string  `json:"pveVersion"`
}

type ProxmoxGuestDisk struct {
	Key       string `json:"key"`
	Volid     string `json:"volid"`
	Storage   string `json:"storage"`
	SizeBytes int64  `json:"sizeBytes"`
	Format    string `json:"format,omitempty"`
	Backup    bool   `json:"backup"`
	// Container mount point path inside the CT ("/" for rootfs); not on the wire.
	MountPath string `json:"-"`
}

type ProxmoxGuest struct {
	VMID             int                `json:"vmid"`
	Type             string             `json:"type"` // qemu | lxc
	Name             string             `json:"name"`
	Node             string             `json:"node"`
	Status           string             `json:"status"`
	Template         bool               `json:"template"`
	Lock             string             `json:"lock,omitempty"`
	HaState          string             `json:"haState,omitempty"`
	Pool             string             `json:"pool,omitempty"`
	Tags             []string           `json:"tags"`
	GuestAgent       *bool              `json:"guestAgent,omitempty"`
	Unprivileged     *bool              `json:"unprivileged,omitempty"`
	Cores            int                `json:"cores,omitempty"`
	MemoryBytes      int64              `json:"memoryBytes,omitempty"`
	Disks            []ProxmoxGuestDisk `json:"disks"`
	AutoMethod       string             `json:"autoMethod"`
	AutoMethodReason string             `json:"autoMethodReason,omitempty"`
	StaleSnapshots   []string           `json:"staleSnapshots"`
}

type ProxmoxStorage struct {
	ID         string   `json:"id"`
	Type       string   `json:"type"`
	Shared     bool     `json:"shared"`
	Content    []string `json:"content"`
	Nodes      []string `json:"nodes"`
	Snapshots  bool     `json:"snapshots"`
	AvailBytes int64    `json:"availBytes,omitempty"`
	TotalBytes int64    `json:"totalBytes,omitempty"`
}

type ProxmoxNodeInfo struct {
	Name   string `json:"name"`
	Online bool   `json:"online"`
}

type ProxmoxInventory struct {
	ClusterName *string           `json:"clusterName"`
	PveVersion  string            `json:"pveVersion"`
	ReadBy      string            `json:"readBy"`
	Nodes       []ProxmoxNodeInfo `json:"nodes"`
	Storages    []ProxmoxStorage  `json:"storages"`
	Guests      []ProxmoxGuest    `json:"guests"`
}

type ProxmoxCbtDisk struct {
	Key       string `json:"key"`
	SizeBytes int64  `json:"sizeBytes"`
}

// ProxmoxCbtState is carried from a successful block backup to the next.
type ProxmoxCbtState struct {
	Bitmap       string           `json:"bitmap"`
	Node         string           `json:"node"`
	SegmentBytes int64            `json:"segmentBytes"`
	Disks        []ProxmoxCbtDisk `json:"disks"`
}

type ProxmoxGuestRef struct {
	VMID int    `json:"vmid"`
	Type string `json:"type"`
	Name string `json:"name"`
	Node string `json:"node"`
}

type ProxmoxRestoreSpec struct {
	ClusterID       string `json:"clusterId"`
	VMID            int    `json:"vmid"`
	GuestType       string `json:"guestType"`
	Action          string `json:"action"` // guest | files | vm-files
	TargetNode      string `json:"targetNode"`
	NewVMID         int    `json:"newVmid,omitempty"`
	ReplaceOriginal bool   `json:"replaceOriginal,omitempty"`
	Storage         string `json:"storage,omitempty"`
	Unique          bool   `json:"unique,omitempty"`
	Name            string `json:"name,omitempty"`
	Start           bool   `json:"start,omitempty"`
	BwlimitKiB      int    `json:"bwlimitKiB,omitempty"`
	TargetVMID      int    `json:"targetVmid,omitempty"`
	// vm-files: directory on the node that receives the files.
	TargetPath string `json:"targetPath,omitempty"`
	// guest (block snapshots): start the VM from the backup at once and move
	// its disks into place while it runs; overlays go to OverlayStorage.
	LiveRestore    bool   `json:"liveRestore,omitempty"`
	OverlayStorage string `json:"overlayStorage,omitempty"`
}

// ProxmoxTask is the Proxmox part of a Task (server: ProxmoxTaskPayload).
type ProxmoxTask struct {
	ClusterID         string              `json:"clusterId"`
	ClusterSlug       string              `json:"clusterSlug"`
	Guest             *ProxmoxGuestRef    `json:"guest,omitempty"`
	VMMethod          string              `json:"vmMethod,omitempty"`
	CTMethod          string              `json:"ctMethod,omitempty"`
	VzdumpMode        string              `json:"vzdumpMode,omitempty"`
	RequireConsistent bool                `json:"requireConsistent,omitempty"`
	ParentSnapshotID  string              `json:"parentSnapshotId,omitempty"`
	Cbt               *ProxmoxCbtState    `json:"cbt,omitempty"`
	Restore           *ProxmoxRestoreSpec `json:"restore,omitempty"`
}

// ProxmoxGuestResult is one guest's outcome (TaskResult.ProxmoxGuest).
type ProxmoxGuestResult struct {
	VMID        int    `json:"vmid"`
	Type        string `json:"type"`
	Name        string `json:"name"`
	Node        string `json:"node"`
	Status      string `json:"status"` // success | failed | moved | skipped
	MovedTo     string `json:"movedTo,omitempty"`
	Method      string `json:"method,omitempty"`
	Consistency string `json:"consistency,omitempty"`
	Cbt         string `json:"cbt,omitempty"`
	CbtReason   string `json:"cbtReason,omitempty"`
	// Pointer so "null" (clear the state) can be told apart from "absent".
	NextCbt         *ProxmoxCbtState `json:"nextCbt"`
	SnapshotID      string           `json:"snapshotId,omitempty"`
	DataAdded       float64          `json:"dataAdded,omitempty"`
	BytesRead       float64          `json:"bytesRead,omitempty"`
	TotalBytes      float64          `json:"totalBytes,omitempty"`
	DurationSeconds float64          `json:"durationSeconds,omitempty"`
	Error           string           `json:"error,omitempty"`
	Warnings        []string         `json:"warnings,omitempty"`
	// restic's file counters (reported in the task's stats, not here).
	filesNew, filesChanged, filesUnmodified float64
}

// ProxmoxRestoreResult goes into the restore's stats as proxmoxRestore.
type ProxmoxRestoreResult struct {
	SourceVMID       int    `json:"sourceVmid"`
	VMID             int    `json:"vmid"`
	Node             string `json:"node"`
	ReplacedOriginal bool   `json:"replacedOriginal,omitempty"`
	LiveRestore      bool   `json:"liveRestore,omitempty"`
	// vm-files: what was copied, and from which partitions.
	FilesRestored int64    `json:"filesRestored,omitempty"`
	BytesRestored int64    `json:"bytesRestored,omitempty"`
	Partitions    []string `json:"partitions,omitempty"`
	TargetPath    string   `json:"targetPath,omitempty"`
	Warnings      []string `json:"warnings,omitempty"`
}

const (
	proxmoxSnapshotTag = "amber-proxmox"
	pveMethodVzdump    = "vzdump"
	pveMethodBlock     = "block"
	pveMethodFiles     = "files"
	pveTypeQemu        = "qemu"
	pveTypeLXC         = "lxc"
	// Prefix of the PVE snapshots (and QEMU bitmaps) Amber creates.
	pveSnapshotPrefix = "amber-"
	pveManifestName   = "manifest.json"
	pveManifestFormat = 1
	// Segment size of the block method's view (16 MiB) and segments per directory.
	pveSegmentBytes   int64 = 16 << 20
	pveSegmentsPerDir       = 256
)
