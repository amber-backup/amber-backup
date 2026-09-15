package main

import (
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
)

// integrityLevels are the check depths the server accepts: 'quick' verifies
// the repository structure, 'rotating' also reads one part of the pack data
// per run, 'full' reads all of it.
var integrityLevels = []string{"quick", "rotating", "full"}

// Polling for `job check --wait`: how often the run is re-read, and how many
// failed reads in a row are tolerated (a full check can run for hours, so a
// short network hiccup should not abort the wait).
const (
	checkPollInterval    = 3 * time.Second
	checkPollMaxFailures = 5
)

func validateLevel(level string) error {
	if !slices.Contains(integrityLevels, level) {
		return usageErrorf("--level must be one of %s", strings.Join(integrityLevels, ", "))
	}
	return nil
}

// integrityConfig returns the job's stored check schedule (the API's
// `integrity_check` object; empty when none was ever set).
func integrityConfig(job map[string]any) map[string]any {
	cfg, _ := job["integrity_check"].(map[string]any)
	if cfg == nil {
		return map[string]any{}
	}
	return cfg
}

// getJob reads a job by id or slug as a JSON object.
func getJob(client *Client, id string) (map[string]any, error) {
	v, err := client.getJSON("/jobs/" + id)
	if err != nil {
		return nil, err
	}
	job, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("unexpected response for job %s", id)
	}
	return job, nil
}

// runJobCheck starts an integrity check of a job's repository and, with
// --wait, follows the run until it finishes.
func runJobCheck(cfg *Config, client *Client, id string) error {
	if id == "" {
		return usageErrorf("job check requires an <id|slug>")
	}
	level := ""
	if cfg.Flags.Level != nil {
		level = *cfg.Flags.Level
		if err := validateLevel(level); err != nil {
			return err
		}
	} else {
		// Without --level, check as deep as the job's schedule would.
		job, err := getJob(client, id)
		if err != nil {
			return err
		}
		level, _ = integrityConfig(job)["level"].(string)
		if !slices.Contains(integrityLevels, level) {
			level = "quick"
		}
	}

	v, err := client.postJSON("/jobs/"+id+"/check", map[string]any{"level": level})
	if err != nil {
		return err
	}
	obj, _ := v.(map[string]any)
	runID := stringify(obj["runId"])

	if !cfg.Flags.Wait {
		if cfg.Format == FormatJSON {
			return printJSON(v)
		}
		fmt.Printf("Started %s integrity check of job %s (run %s)\n", level, id, runID)
		return nil
	}

	fmt.Fprintf(os.Stderr, "Started %s integrity check of job %s (run %s), waiting for it to finish…\n", level, id, runID)
	run, err := waitForRun(client, runID, checkPollInterval, time.Sleep)
	if err != nil {
		return err
	}
	passed, summary := checkVerdict(run)
	if cfg.Format == FormatJSON {
		if err := printJSON(run); err != nil {
			return err
		}
		if !passed {
			return &exitCodeError{code: 1}
		}
		return nil
	}
	if !passed {
		return fmt.Errorf("%s", summary)
	}
	fmt.Println(summary)
	return nil
}

// waitForRun polls a run until it has left the queued/running states and
// returns its final record.
func waitForRun(client *Client, runID string, interval time.Duration, sleep func(time.Duration)) (map[string]any, error) {
	failures := 0
	for {
		v, err := client.getJSON("/runs/" + runID)
		if err != nil {
			// Client errors (not found, forbidden) will not go away; network
			// failures and 5xx (e.g. a server restart) may.
			if ae, ok := err.(*apiError); ok && ae.status < 500 {
				return nil, err
			}
			failures++
			if failures >= checkPollMaxFailures {
				return nil, fmt.Errorf("lost track of run %s: %w", runID, err)
			}
		} else {
			failures = 0
			run, _ := v.(map[string]any)
			switch run["status"] {
			case "queued", "running":
			default:
				return run, nil
			}
		}
		sleep(interval)
	}
}

// checkVerdict tells whether a finished check run passed, with a one-line
// summary for the terminal.
func checkVerdict(run map[string]any) (bool, string) {
	status := stringify(run["status"])
	info, _ := run["check_info"].(map[string]any)
	scope := stringify(info["level"])
	if part, ok := info["part"].(float64); ok {
		scope = fmt.Sprintf("%s, part %s of %s", scope, stringify(part), stringify(info["parts"]))
	}
	switch {
	case status == "success":
		return true, fmt.Sprintf("Integrity check passed (%s)", scope)
	case info["damaged"] == true:
		return false, fmt.Sprintf("integrity check found damage (%s): %s — see the run log in the web UI", scope, stringify(run["error"]))
	case status == "cancelled":
		return false, "integrity check was cancelled"
	default:
		return false, fmt.Sprintf("integrity check failed: %s", stringify(run["error"]))
	}
}

// buildIntegrityPayload merges the 'job integrity' flags into the job's stored
// check schedule and returns the PUT body. The server replaces the schedule as
// a whole, so every field not changed by a flag is carried over.
func buildIntegrityPayload(flags *CommandFlags, current map[string]any) (map[string]any, error) {
	if flags.Enable && flags.Disable {
		return nil, usageErrorf("--enable and --disable are mutually exclusive")
	}
	if flags.Disable && flags.Cron != nil {
		return nil, usageErrorf("--cron enables the schedule and cannot be combined with --disable")
	}

	enabled, _ := current["enabled"].(bool)
	cron, _ := current["cronExpr"].(string)
	level, _ := current["level"].(string)
	if !slices.Contains(integrityLevels, level) {
		level = "quick"
	}
	parts := 0
	if p, ok := current["subsetParts"].(float64); ok {
		parts = int(p)
	}

	if flags.Cron != nil {
		cron = strings.TrimSpace(*flags.Cron)
		if cron == "" {
			return nil, usageErrorf("--cron needs a cron expression, e.g. \"0 4 * * 0\"")
		}
		enabled = true
	}
	if flags.Enable {
		if cron == "" {
			return nil, usageErrorf("the job has no check schedule yet: pass --cron <expr>")
		}
		enabled = true
	}
	if flags.Disable {
		enabled = false
	}
	if flags.Level != nil {
		if err := validateLevel(*flags.Level); err != nil {
			return nil, err
		}
		level = *flags.Level
	}
	if flags.Parts != nil {
		n, err := strconv.Atoi(*flags.Parts)
		if err != nil || n < 2 || n > 100 {
			return nil, usageErrorf("--parts must be a number between 2 and 100")
		}
		if level != "rotating" {
			return nil, usageErrorf("--parts only applies to --level rotating")
		}
		parts = n
	}

	body := map[string]any{"enabled": enabled, "level": level}
	if cron != "" {
		body["cronExpr"] = cron
	}
	if level == "rotating" && parts > 0 {
		body["subsetParts"] = parts
	}
	return body, nil
}

// integrityStatus extracts the integrity view of a job from its API record.
func integrityStatus(job map[string]any) map[string]any {
	return map[string]any{
		"job_id":           job["id"],
		"slug":             job["slug"],
		"schedule":         job["integrity_check"],
		"next_check":       job["next_check"],
		"check_status":     job["repo_check_status"],
		"check_at":         job["repo_check_at"],
		"check_level":      job["repo_check_level"],
		"check_error":      job["repo_check_error"],
		"data_verified_at": job["repo_data_verified_at"],
		"subset_next":      job["repo_check_subset_next"],
		"subset_parts":     job["repo_check_subset_parts"],
	}
}

// runJobIntegrity shows a job's integrity status or, given schedule flags,
// changes its check schedule and shows the result.
func runJobIntegrity(cfg *Config, client *Client, id string) error {
	if id == "" {
		return usageErrorf("job integrity requires an <id|slug>")
	}
	job, err := getJob(client, id)
	if err != nil {
		return err
	}
	if cfg.Flags.integrityScheduleUsed() || cfg.Flags.Level != nil {
		body, err := buildIntegrityPayload(&cfg.Flags, integrityConfig(job))
		if err != nil {
			return err
		}
		v, err := client.putJSON("/jobs/"+id+"/integrity-check", body)
		if err != nil {
			return err
		}
		updated, ok := v.(map[string]any)
		if !ok {
			return fmt.Errorf("unexpected response for job %s", id)
		}
		job = updated
		if cfg.Format != FormatJSON {
			fmt.Fprintf(os.Stderr, "Updated the check schedule of job %s\n", id)
		}
	}

	status := integrityStatus(job)
	if cfg.Format == FormatJSON {
		return printJSON(status)
	}
	return printIntegrityStatus(job)
}

// printIntegrityStatus renders a job's integrity status as a readable block.
func printIntegrityStatus(job map[string]any) error {
	sched := integrityConfig(job)
	schedule := "disabled"
	if enabled, _ := sched["enabled"].(bool); enabled {
		schedule = fmt.Sprintf("%s (%s)", stringify(sched["cronExpr"]), describeLevel(sched))
	} else if _, ok := sched["level"]; ok {
		schedule = fmt.Sprintf("disabled (%s)", describeLevel(sched))
	}

	result := "never checked"
	if s, ok := job["repo_check_status"].(string); ok && s != "" {
		result = fmt.Sprintf("%s (%s, %s)", s, stringify(job["repo_check_level"]), stringify(job["repo_check_at"]))
	}

	rotation := "-"
	if parts, ok := job["repo_check_subset_parts"].(float64); ok && parts > 0 {
		rotation = fmt.Sprintf("next part %s of %s", stringify(job["repo_check_subset_next"]), stringify(parts))
	}

	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	for _, row := range [][2]string{
		{"job", stringify(job["slug"])},
		{"schedule", schedule},
		{"next_check", stringify(job["next_check"])},
		{"last_result", result},
		{"last_error", stringify(job["repo_check_error"])},
		{"data_verified_at", stringify(job["repo_data_verified_at"])},
		{"rotation", rotation},
	} {
		fmt.Fprintf(tw, "%s\t%s\n", row[0], row[1])
	}
	return tw.Flush()
}

// describeLevel renders a schedule's level, with the split of a rotating one.
func describeLevel(sched map[string]any) string {
	level := stringify(sched["level"])
	if parts, ok := sched["subsetParts"].(float64); ok && level == "rotating" {
		return fmt.Sprintf("rotating, %s parts", stringify(parts))
	}
	return level
}
