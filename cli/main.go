// Command ambb is the Amber Backup CLI. It talks to the Amber Backup server's
// REST API to list and inspect agents, jobs and targets, and to trigger jobs.
package main

import (
	"fmt"
	"os"
	"strings"
)

const usage = `ambb — Amber Backup CLI

Usage:
  ambb [global flags] <command> <action> [id|slug]

Commands:
  agent list                      List enrolled agents (requires an admin API key)
  agent inspect <id|slug>         Show a single agent
  job list                        List backup jobs
  job inspect <id|slug>           Show a single job
  job run <id|slug>               Trigger a job manually
  repo list                       List repositories
  repo inspect <id|slug>          Show a repository (with size and snapshot count)
  repo use <id|slug> -- <args>    Run restic against the repository (remote repos only)
  target list                     List connections (shared backends)
  target inspect <id|slug>        Show a single target

Entities can be addressed by UUID or by their slug — the lowercase kebab-case
identifier derived from the entity's name (shown in list output).

Global flags:
  --url <url>                Server base URL         (env AMBER_URL / AMBB_URL)
  --api-key <key>            API key (ak_...)        (env AMBER_API_KEY / AMBB_API_KEY)
  --output-format <fmt>      Output format: text|json  (default text)
  -o <fmt>                   Alias for --output-format
  -h, --help                 Show this help
  --version                  Print the CLI version

Examples:
  ambb --url http://localhost:3000 --api-key ak_xxxx agent list
  ambb agent inspect web-1
  ambb --output-format json target list
  ambb job run daily-backup
  ambb repo use offsite-s3 -- snapshots --json
  ambb repo use 7cc2... -- mount /mnt/restic

Everything after '--' is passed verbatim to restic (needs restic on PATH).
`

// usageError marks an error that should print usage and exit with code 2.
type usageError struct{ msg string }

func (e *usageError) Error() string { return e.msg }

func usageErrorf(format string, args ...any) error {
	return &usageError{msg: fmt.Sprintf(format, args...)}
}

func main() {
	cfg := &Config{}
	positionals, err := parseArgs(os.Args[1:], cfg)
	if err != nil {
		fail(err)
	}

	if err := cfg.resolve(); err != nil {
		fail(err)
	}

	if len(positionals) == 0 {
		fmt.Print(usage)
		os.Exit(0)
	}

	resource := positionals[0]
	action := ""
	id := ""
	if len(positionals) > 1 {
		action = positionals[1]
	}
	if len(positionals) > 2 {
		id = positionals[2]
	}
	if action == "" {
		fail(usageErrorf("command %q needs an action (e.g. list, inspect)", resource))
	}
	var rest []string
	if len(positionals) > 3 {
		rest = positionals[3:]
	}

	if err := runCommand(cfg, resource, action, id, rest); err != nil {
		// A restic passthrough (repo use) carries restic's own exit code; exit
		// with it directly and print nothing extra.
		if ec, ok := err.(*exitCodeError); ok {
			os.Exit(ec.code)
		}
		fail(err)
	}
}

// parseArgs extracts global flags (which may appear anywhere) from args and
// returns the remaining positional arguments. Handles --help and --version by
// exiting directly.
func parseArgs(args []string, cfg *Config) ([]string, error) {
	var positionals []string

	// takeValue returns the inline (--flag=value) or next-arg value for a flag.
	for i := 0; i < len(args); i++ {
		arg := args[i]

		// A bare "--" ends flag parsing: everything after it is passthrough
		// (e.g. restic arguments for `repo use`), taken verbatim.
		if arg == "--" {
			positionals = append(positionals, args[i+1:]...)
			break
		}

		name, inlineVal, hasInline := arg, "", false
		if strings.HasPrefix(arg, "--") {
			if eq := strings.IndexByte(arg, '='); eq >= 0 {
				name, inlineVal, hasInline = arg[:eq], arg[eq+1:], true
			}
		}

		next := func() (string, error) {
			if hasInline {
				return inlineVal, nil
			}
			if i+1 >= len(args) {
				return "", usageErrorf("flag %s needs a value", name)
			}
			i++
			return args[i], nil
		}

		switch name {
		case "-h", "--help":
			fmt.Print(usage)
			os.Exit(0)
		case "--version":
			fmt.Printf("ambb %s\n", Version)
			os.Exit(0)
		case "--url":
			v, err := next()
			if err != nil {
				return nil, err
			}
			cfg.URL = v
		case "--api-key":
			v, err := next()
			if err != nil {
				return nil, err
			}
			cfg.APIKey = v
		case "--output-format", "-o":
			v, err := next()
			if err != nil {
				return nil, err
			}
			cfg.Format = OutputFormat(v)
		default:
			if strings.HasPrefix(arg, "-") && arg != "-" {
				return nil, usageErrorf("unknown flag %q", arg)
			}
			positionals = append(positionals, arg)
		}
	}
	return positionals, nil
}

// fail prints an error to stderr and exits (code 2 for usage errors, else 1).
func fail(err error) {
	fmt.Fprintf(os.Stderr, "ambb: %s\n", err)
	if _, ok := err.(*usageError); ok {
		fmt.Fprintln(os.Stderr, "\nRun 'ambb --help' for usage.")
		os.Exit(2)
	}
	os.Exit(1)
}
