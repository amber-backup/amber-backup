package main

import (
	"fmt"
)

var agentColumns = []column{
	{"ID", "id"},
	{"NAME", "name"},
	{"HOSTNAME", "hostname"},
	{"OS", "os"},
	{"STATUS", "status"},
	{"VERSION", "agent_version"},
	{"LAST SEEN", "last_seen_at"},
}

var jobColumns = []column{
	{"ID", "id"},
	{"NAME", "name"},
	{"ENABLED", "enabled"},
	{"CRON", "cron_expr"},
	{"NEXT RUN", "next_run"},
	{"TARGET", "target_id"},
	{"AGENT", "agent_id"},
}

var targetColumns = []column{
	{"ID", "id"},
	{"NAME", "name"},
	{"BACKEND", "backend_type"},
	{"CREATED", "created_at"},
}

var repoColumns = []column{
	{"ID", "id"},
	{"NAME", "name"},
	{"TARGET", "target"},
	{"TYPE", "type"},
}

// runCommand dispatches a parsed resource/action/id triple to the API.
func runCommand(cfg *Config, resource, action, id string) error {
	switch resource {
	case "agent", "agents", "job", "jobs", "target", "targets", "repo", "repos":
	default:
		return usageErrorf("unknown command %q", resource)
	}

	if err := cfg.requireCredentials(); err != nil {
		return err
	}
	client := NewClient(cfg)

	switch resource {
	case "agent", "agents":
		return runResource(cfg, client, "agents", agentColumns, action, id, false)
	case "job", "jobs":
		return runJob(cfg, client, action, id)
	case "repo", "repos":
		return runResource(cfg, client, "repositories", repoColumns, action, id, false)
	default: // target, targets
		return runResource(cfg, client, "targets", targetColumns, action, id, false)
	}
}

// runResource handles the shared list/inspect actions for a resource path.
func runResource(cfg *Config, client *Client, path string, cols []column, action, id string, _ bool) error {
	switch action {
	case "list", "ls":
		v, err := client.getJSON("/" + path)
		if err != nil {
			return err
		}
		return renderList(cfg, v, cols)
	case "inspect", "get", "show":
		if id == "" {
			return usageErrorf("%s inspect requires an <ID>", singular(path))
		}
		v, err := client.getJSON("/" + path + "/" + id)
		if err != nil {
			return err
		}
		return renderRecord(cfg, v)
	default:
		return usageErrorf("unknown action %q for %s (want: list, inspect)", action, singular(path))
	}
}

// runJob adds the "run" action on top of the shared list/inspect behavior.
func runJob(cfg *Config, client *Client, action, id string) error {
	switch action {
	case "run":
		if id == "" {
			return usageErrorf("job run requires an <ID>")
		}
		v, err := client.postJSON("/jobs/"+id+"/run", nil)
		if err != nil {
			return err
		}
		if cfg.Format == FormatJSON {
			return printJSON(v)
		}
		runID := ""
		if obj, ok := v.(map[string]any); ok {
			runID = stringify(obj["runId"])
		}
		fmt.Printf("Triggered job %s (run %s)\n", id, runID)
		return nil
	default:
		return runResource(cfg, client, "jobs", jobColumns, action, id, false)
	}
}

// singular strips a trailing "s" for nicer error messages.
func singular(path string) string {
	if len(path) > 1 && path[len(path)-1] == 's' {
		return path[:len(path)-1]
	}
	return path
}
