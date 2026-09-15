# ambb — Amber Backup CLI

A small, dependency-free Go CLI for the Amber Backup server's REST API. It lists
and inspects agents, jobs, repositories and targets, and triggers jobs manually.

## Download

Prebuilt binaries for Linux, macOS and Windows (amd64/arm64) are attached to
every [GitHub Release](https://github.com/amber-backup/amber-backup/releases),
together with a `checksums.txt`. Each archive also carries a signed build
provenance attestation, verifiable with
`gh attestation verify <archive> --repo amber-backup/amber-backup`.

## Update

```bash
ambb update           # install the latest release over this binary
ambb update --check   # only report whether a newer release exists
```

`update` downloads the archive for the current OS/architecture from the latest
GitHub Release — over HTTPS from GitHub only — verifies its SHA-256 against the
release's `checksums.txt`, checks that the new binary runs and reports the
release version, and then atomically replaces the running executable. If the
binary lives in a root-owned directory, run it with `sudo`. A development build
(`ambb --version` shows `dev`) is only replaced with `--force`.

## Build

```bash
cd cli
go build -o bin/ambb .
```

The binary is self-contained (standard library only).

## Login

```bash
ambb login amber.example.com     # https:// is assumed
ambb job list                    # uses the saved login
ambb logout                      # revokes the key and forgets it
```

`login` pairs this device with your account without copying an API key by hand
(OAuth device flow, RFC 8628): it prints a link and a code such as `BCDF-GHJK`
and opens the link in your browser if a desktop is available. Sign in there,
check that the page shows the same code and approve the request — choosing
**read-only** (default) or **full** access and when the key expires. The CLI
then receives a newly issued API key (named `CLI: <hostname>`, listed and
revocable under *Settings → API keys*).

| Flag | Effect |
|------|--------|
| `--name <name>` | Device name shown on the approval page (default: hostname) |
| `--no-browser` | Only print the link |
| `--insecure-http` | Allow login over plain HTTP to a non-local server |

Security notes:

- Only approve a request you started yourself and whose code matches your
  terminal — never one from a link someone sent you.
- The request expires after 10 minutes and yields at most one key; approval
  requires a signed-in browser session and cannot be done with an API key.
- Login over plain HTTP is refused unless the server is on this machine or
  `--insecure-http` is given.
- Credentials are stored per server in `credentials.json` under the user config
  directory (`~/.config/ambb` on Linux; override with `AMBB_CONFIG_DIR`), with
  owner-only permissions (`0600`). A file readable by others is refused. A saved
  key is only ever sent to the server it was issued by.
- `logout` revokes the key on the server before deleting it locally; if the
  server cannot be reached, the local copy is kept so you can retry.

## Configuration

The CLI needs a server base URL and an API key (prefix `ak_`). Provide them as
flags or environment variables — flags win — or use the login saved by
`ambb login`, which applies when no API key is given.

| Setting       | Flag              | Environment variable            |
|---------------|-------------------|---------------------------------|
| Server URL    | `--url`           | `AMBER_URL` / `AMBB_URL`         |
| API key       | `--api-key`       | `AMBER_API_KEY` / `AMBB_API_KEY` |
| Output format | `--output-format` (`-o`) | `AMBB_OUTPUT_FORMAT`     |

Output format is `text` (default) or `json`. Global flags may appear before or
after the command.

> Agent commands require an API key whose owner is an administrator:
> `agent list` / `agent inspect` work with any key (read-only included),
> `agent create` needs a **full-access** key. Other admin operations (users,
> settings, rotating or removing agents) stay limited to the web UI. Job,
> repository and target commands are governed by per-resource grants on the
> key owner.

## Commands

```text
ambb login <server>                 Sign in this device via the browser
ambb logout [server]                Revoke and forget the saved login
ambb agent list                     List enrolled agents
ambb agent inspect <id|slug>        Show a single agent
ambb agent create [name]            Create an enrollment token + install command
ambb job list                       List backup jobs
ambb job inspect <id|slug>          Show a single job
ambb job run <id|slug>              Trigger a job manually
ambb job credentials <id|slug>      Set or clear the job's credential override
ambb job check <id|slug>            Start an integrity check of the job's repository
ambb job integrity <id|slug>        Show the integrity status / change the check schedule
ambb repo list                      List repositories
ambb repo inspect <id|slug>         Show a repository (with size and snapshot count)
ambb repo use <id|slug> -- <args>   Run restic against the repository
ambb target list                    List connections (shared backends)
ambb target inspect <id|slug>       Show a single target
ambb update [--check] [--force]     Install the latest release from GitHub
```

Single-entity commands accept either the entity's UUID or its **slug** — a
unique, lowercase kebab-case identifier the server derives from the entity's
name (e.g. `Daily Backup` → `daily-backup`, with `-2`, `-3`, … appended on name
collisions). Slugs are shown in every `list` output, are not editable, and
change automatically when the entity is renamed.

`repo inspect` reports the repository's deduplicated size and snapshot count,
read live from restic; on an unreachable repository both are `null` and a
`stats_error` field explains why.

### `agent create` — enroll a new agent

Creates a single-use enrollment token and prints the command that installs and
enrolls the agent on the target host (to stdout, so it can be piped; the expiry
notice goes to stderr). The optional name is suggested to the agent as its own.

```bash
ambb agent create web-2                              # binary install script
ambb agent create web-2 --method docker --expires 120
ambb -o json agent create                            # token, expiresAt, installCommand
```

| Flag | Effect |
|------|--------|
| `--method <method>` | `binary` (default), `docker` or `docker-compose` |
| `--expires <minutes>` | Token lifetime, 1–10080 (default 60) |

### `job credentials` — per-job credential override

A backup job normally authenticates with the credentials stored on its
connection. Some backends hand out an account per repository — a restic REST
server started with `--private-repos` is the typical case — so a job may carry
its own credentials instead. They are stored encrypted on the server, never
returned by the API, and win over the connection's for that one job.

```bash
ambb job credentials daily-backup --username repo1 --password s3cret
ambb job credentials daily-backup --password-stdin < password.txt
ambb job credentials daily-backup --username repo1     # keeps the stored password
ambb job credentials daily-backup --clear              # back to the connection's
```

| Flag | Effect |
|------|--------|
| `--username <user>` | Sets the override's username |
| `--password <pass>` | Sets the override's password (visible in the shell history — prefer `--password-stdin`) |
| `--password-stdin` | Reads the password from stdin; the trailing newline is stripped |
| `--clear` | Removes the override entirely |

Only the flags you pass are sent, and the server merges them into the stored
override — setting just the password keeps the username. `--clear` cannot be
combined with a value, and the flags are rejected on any other command.

Which fields a connection allows a job to override comes from the backend
definition (`GET /api/targets/backends`, fields flagged `overridable`);
currently that is the REST server's username and password. Requires **manage**
access on the job. `job inspect` and `repo list` show whether an override is in
place (`has_credential_override`), never its values. Moving a job to another
connection drops the override, because it belonged to the old one.

### `job check` / `job integrity` — repository integrity checks

`job check` starts a `restic check` of the job's repository — on the server or,
for a remote job, on its agent — and prints the run id.

```bash
ambb job check daily-backup                     # at the job's scheduled level, else quick
ambb job check daily-backup --level full --wait # exit code 1 unless it passed
ambb -o json job check daily-backup --wait      # final run record as JSON
```

| Level | Verifies |
|-------|----------|
| `quick` | Repository structure only |
| `rotating` | Structure plus the next part of the pack data (`--read-data-subset=n/parts`); a full rotation reads everything back |
| `full` | Structure plus all pack data (slow, reads the whole repository) |

With `--wait` the CLI follows the run until it finishes and exits `0` only if
the check passed; damage, failure (e.g. a locked repository or an agent too old
to run checks) and cancellation exit with `1`. Short network or server outages
while waiting are tolerated. Requires **operate** access on the job; the server
refuses a check while a backup, prune or check of the job is in progress.

`job integrity` shows the last verdict, when all data was last read back, the
rotation progress and the schedule. Given any of the flags below it first
changes the schedule (**manage** access), keeping every setting not named:

```bash
ambb job integrity daily-backup
ambb job integrity daily-backup --cron "0 4 * * 0" --level rotating --parts 12
ambb job integrity daily-backup --disable
ambb job integrity daily-backup --enable        # back on with the stored cron
```

| Flag | Effect |
|------|--------|
| `--cron <expr>` | Check on this schedule (also enables it) |
| `--enable` / `--disable` | Switch scheduled checks on or off |
| `--level <level>` | `quick`, `rotating` or `full` (also valid for `job check`) |
| `--parts <n>` | Parts a rotating check splits the data into, 2–100 (server default 12) |

`job list` shows each repository's last verdict in the `CHECK` column
(`passed`, `damaged`, or `-` if never checked).

### `repo use` — restic wrapper

`repo use` turns the CLI into a thin restic wrapper: it asks the server to
resolve the repository's connection details, sets up the restic environment
(repository URL, password, backend credentials, credential files) and execs your
local `restic` with everything after `--` passed straight through.

```bash
ambb repo use <id|slug> -- snapshots
ambb repo use <id|slug> -- stats --mode raw-data
ambb repo use <id|slug> -- restore latest --target /tmp/out
ambb repo use <id|slug> -- mount /mnt/restic   # long-running; Ctrl-C unmounts
```

Requirements and caveats:

- `restic` must be on `PATH` (override with `RESTIC_BINARY`).
- Only repositories on a **shared connection** (s3, sftp, b2, …) can be used —
  a local filesystem repository lives on the server and is rejected.
- Requires **operate** access on the owning backup job. The call returns
  decrypted repository credentials to the CLI host, so it is audit-logged on the
  server. All restic subcommands are allowed, including destructive ones
  (`forget --prune`, `restore`, …) and `mount`.
- The CLI's own exit status is restic's exit code.

## Examples

```bash
ambb --url http://localhost:3000 --api-key ak_xxxx agent list
ambb agent inspect web-1
ambb job list
ambb job inspect daily-backup
ambb --output-format json target list
ambb -o text target inspect offsite-s3
ambb job run 9a1b...
```

## Exit codes

- `0` — success
- `1` — runtime error (network failure, API error, etc.)
- `2` — usage error (unknown command/flag, missing argument)
