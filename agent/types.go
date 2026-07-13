package main

// Wire types shared with the Amber server API.

type EnrollRequest struct {
	Token        string `json:"token"`
	AgentName    string `json:"agentName"`
	Hostname     string `json:"hostname,omitempty"`
	OS           string `json:"os,omitempty"`
	Pubkey       string `json:"pubkey,omitempty"`
	AgentVersion string `json:"agentVersion,omitempty"`
}

type EnrollResponse struct {
	AgentID             string `json:"agentId"`
	AgentKey            string `json:"agentKey"`
	ServerPubkey        string `json:"serverPubkey"`
	PollIntervalSeconds int    `json:"pollIntervalSeconds"`
}

type PollRequest struct {
	ResticVersion string `json:"resticVersion,omitempty"`
	AgentVersion  string `json:"agentVersion,omitempty"`
}

type CredentialFile struct {
	EnvVar   string `json:"envVar"`
	Filename string `json:"filename"`
	Content  string `json:"content"`
}

type Retention struct {
	KeepLast    *int     `json:"keepLast,omitempty"`
	KeepHourly  *int     `json:"keepHourly,omitempty"`
	KeepDaily   *int     `json:"keepDaily,omitempty"`
	KeepWeekly  *int     `json:"keepWeekly,omitempty"`
	KeepMonthly *int     `json:"keepMonthly,omitempty"`
	KeepYearly  *int     `json:"keepYearly,omitempty"`
	KeepWithin  string   `json:"keepWithin,omitempty"`
	KeepTags    []string `json:"keepTags,omitempty"`
	Prune       bool     `json:"prune,omitempty"`
}

type ResticOptions struct {
	Tags              []string   `json:"tags,omitempty"`
	Exclude           []string   `json:"exclude,omitempty"`
	IExclude          []string   `json:"iexclude,omitempty"`
	ExcludeFile       []string   `json:"excludeFile,omitempty"`
	OneFileSystem     bool       `json:"oneFileSystem,omitempty"`
	ExcludeCaches     bool       `json:"excludeCaches,omitempty"`
	ExcludeLargerThan string     `json:"excludeLargerThan,omitempty"`
	Compression       string     `json:"compression,omitempty"`
	ReadConcurrency   int        `json:"readConcurrency,omitempty"`
	Retention         *Retention `json:"retention,omitempty"`
	// Custom scripts run by path (no shell). PreScript gates the backup; the
	// post scripts run on success/failure and are best-effort.
	PreScript         string `json:"preScript,omitempty"`
	PostSuccessScript string `json:"postSuccessScript,omitempty"`
	PostFailureScript string `json:"postFailureScript,omitempty"`
}

type RestoreOptions struct {
	Overwrite string   `json:"overwrite,omitempty"`
	Verify    bool     `json:"verify,omitempty"`
	Delete    bool     `json:"delete,omitempty"`
	DryRun    bool     `json:"dryRun,omitempty"`
	Include   []string `json:"include,omitempty"`
	Exclude   []string `json:"exclude,omitempty"`
}

type Task struct {
	Type            string            `json:"type"`
	TaskID          string            `json:"taskId"`
	Repository      string            `json:"repository"`
	Password        string            `json:"password"`
	Env             map[string]string `json:"env"`
	CredentialFiles []CredentialFile  `json:"credentialFiles"`
	// Extra restic global options prepended before the subcommand (e.g. the
	// SFTP -o sftp.command=...). May reference credential file paths via a
	// {{credentialFile:<filename>}} placeholder.
	ExtraArgs []string `json:"extraArgs,omitempty"`
	// backup
	JobID   string         `json:"jobId,omitempty"`
	JobName string         `json:"jobName,omitempty"`
	Paths   []string       `json:"paths,omitempty"`
	Options *ResticOptions `json:"options,omitempty"`
	// restore
	SnapshotID     string          `json:"snapshotId,omitempty"`
	TargetPath     string          `json:"targetPath,omitempty"`
	IncludedPaths  []string        `json:"includedPaths,omitempty"`
	RestoreOptions *RestoreOptions `json:"restoreOptions,omitempty"`
}

type PollResponse struct {
	Tasks               []Task `json:"tasks"`
	PollIntervalSeconds int    `json:"pollIntervalSeconds"`
	// Latest agent version the server has bundled; triggers a self-update when
	// newer than the running agent. Empty when the server can't determine it.
	LatestAgentVersion string `json:"latestAgentVersion,omitempty"`
}

type TaskResult struct {
	Status       string         `json:"status"`
	SnapshotID   string         `json:"snapshotId,omitempty"`
	Stats        map[string]any `json:"stats,omitempty"`
	ForgetResult any            `json:"forgetResult,omitempty"`
	Error        string         `json:"error,omitempty"`
	Log          string         `json:"log,omitempty"`
}

type State struct {
	AgentID      string `json:"agentId"`
	AgentKey     string `json:"agentKey"`
	ServerPubkey string `json:"serverPubkey"`
}
