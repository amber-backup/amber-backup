// Command ambb is the Amber Backup CLI. It talks to the Amber Backup server's
// REST API to list and inspect agents, jobs and targets, to enroll agents and
// to trigger jobs.
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
  login <server>                  Sign in this device via the browser (no API key needed)
  logout [server]                 Revoke and forget the key saved by login
  agent list                      List enrolled agents (admin)
  agent inspect <id|slug>         Show a single agent (admin)
  agent create [name]             Create an enrollment token + install command
                                  (admin, full-access key)
  job list                        List backup jobs
  job inspect <id|slug>           Show a single job
  job run <id|slug>               Trigger a job manually
  job credentials <id|slug>       Set or clear the job's credential override
  repo list                       List repositories
  repo inspect <id|slug>          Show a repository (with size and snapshot count)
  repo use <id|slug> -- <args>    Run restic against the repository (remote repos only)
  target list                     List connections (shared backends)
  target inspect <id|slug>        Show a single target
  update                          Install the latest release from GitHub

Entities can be addressed by UUID or by their slug — the lowercase kebab-case
identifier derived from the entity's name (shown in list output).

Global flags:
  --url <url>                Server base URL         (env AMBER_URL / AMBB_URL)
  --api-key <key>            API key (ak_...)        (env AMBER_API_KEY / AMBB_API_KEY)
                             Without either, the server and key saved by
                             'ambb login' are used.
  --output-format <fmt>      Output format: text|json  (default text)
  -o <fmt>                   Alias for --output-format
  -h, --help                 Show this help
  --version                  Print the CLI version

Flags for 'job credentials' (a job may authenticate against its connection with
its own credentials, e.g. a REST server with per-repository accounts):
  --username <user>          Set the override's username
  --password <pass>          Set the override's password
  --password-stdin           Read the password from stdin instead (safer)
  --clear                    Remove the override; the connection's own
                             credentials apply again

Flags for 'agent create' (prints the command that installs and enrolls the
agent on the target host; the token is single-use):
  --method <method>          binary|docker|docker-compose  (default binary)
  --expires <minutes>        Token lifetime, 1-10080       (default 60)

Flags for 'login' (prints a link and a code; approve the request in the web UI,
where you also choose read-only or full access and the key's lifetime):
  --name <name>              Device name shown for approval (default: hostname)
  --no-browser               Only print the link, do not open a browser
  --insecure-http            Allow login over plain HTTP to a non-local server

Flags for 'update' (downloads the latest GitHub release, verifies its SHA-256
checksum and replaces this binary in place):
  --check                    Only report whether a newer release exists
  --force                    Reinstall even if up to date (or over a dev build)

Examples:
  ambb login amber.example.com
  ambb --url http://localhost:3000 --api-key ak_xxxx agent list
  ambb agent inspect web-1
  ambb agent create web-2 --method docker --expires 120
  ambb --output-format json target list
  ambb job run daily-backup
  ambb job credentials daily-backup --username repo1 --password-stdin < pw.txt
  ambb repo use offsite-s3 -- snapshots --json
  ambb repo use 7cc2... -- mount /mnt/restic
  ambb update

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
	switch resource {
	case "update", "login", "logout":
		if err := runTopLevel(cfg, resource, positionals[1:]); err != nil {
			fail(err)
		}
		return
	}
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

// runTopLevel runs the commands that take no resource/action pair.
func runTopLevel(cfg *Config, command string, args []string) error {
	allowed := ""
	switch command {
	case "update", "login":
		allowed = command
	}
	if err := cfg.Flags.rejectFlagsExcept(allowed); err != nil {
		return err
	}
	maxArgs := 1
	if command == "update" {
		maxArgs = 0
	}
	if len(args) > maxArgs {
		return usageErrorf("too many arguments for %s", command)
	}
	server := ""
	if len(args) == 1 {
		server = args[0]
	}
	switch command {
	case "update":
		return runUpdate(&cfg.Flags)
	case "login":
		return runLogin(cfg, server)
	default:
		return runLogout(cfg, server)
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
		case "--username":
			v, err := next()
			if err != nil {
				return nil, err
			}
			cfg.Flags.Username = strPtr(v)
		case "--password":
			v, err := next()
			if err != nil {
				return nil, err
			}
			cfg.Flags.Password = strPtr(v)
		case "--password-stdin":
			cfg.Flags.PasswordStdin = true
		case "--clear":
			cfg.Flags.Clear = true
		case "--check":
			cfg.Flags.Check = true
		case "--force":
			cfg.Flags.Force = true
		case "--name":
			v, err := next()
			if err != nil {
				return nil, err
			}
			cfg.Flags.Name = strPtr(v)
		case "--method":
			v, err := next()
			if err != nil {
				return nil, err
			}
			cfg.Flags.Method = strPtr(v)
		case "--expires":
			v, err := next()
			if err != nil {
				return nil, err
			}
			cfg.Flags.Expires = strPtr(v)
		case "--no-browser":
			cfg.Flags.NoBrowser = true
		case "--insecure-http":
			cfg.Flags.InsecureHTTP = true
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
