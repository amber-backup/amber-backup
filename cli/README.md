# ambb — Amber Backup CLI

A small, dependency-free Go CLI for the Amber Backup server's REST API. It lists
and inspects agents, jobs, repositories and targets, and triggers jobs manually.

## Build

```bash
cd cli
go build -o bin/ambb .
```

The binary is self-contained (standard library only).

## Configuration

The CLI needs a server base URL and an API key (prefix `ak_`). Provide them as
flags or environment variables — flags win.

| Setting       | Flag              | Environment variable            |
|---------------|-------------------|---------------------------------|
| Server URL    | `--url`           | `AMBER_URL` / `AMBB_URL`         |
| API key       | `--api-key`       | `AMBER_API_KEY` / `AMBB_API_KEY` |
| Output format | `--output-format` (`-o`) | `AMBB_OUTPUT_FORMAT`     |

Output format is `text` (default) or `json`. Global flags may appear before or
after the command.

> Agent commands (`agent list` / `agent inspect`) require an API key whose owner
> is an administrator. Job, repository and target commands are governed by
> per-resource grants on the key owner.

## Commands

```text
ambb agent list                List enrolled agents
ambb agent inspect <id>        Show a single agent
ambb job list                  List backup jobs
ambb job inspect <id>          Show a single job
ambb job run <id>              Trigger a job manually
ambb repo list                 List repositories
ambb repo inspect <id>         Show a repository (with size and snapshot count)
ambb repo use <id> -- <args>   Run restic against the repository
ambb target list               List connections (shared backends)
ambb target inspect <id>       Show a single target
```

`repo inspect` reports the repository's deduplicated size and snapshot count,
read live from restic; on an unreachable repository both are `null` and a
`stats_error` field explains why.

### `repo use` — restic wrapper

`repo use` turns the CLI into a thin restic wrapper: it asks the server to
resolve the repository's connection details, sets up the restic environment
(repository URL, password, backend credentials, credential files) and execs your
local `restic` with everything after `--` passed straight through.

```bash
ambb repo use <id> -- snapshots
ambb repo use <id> -- stats --mode raw-data
ambb repo use <id> -- restore latest --target /tmp/out
ambb repo use <id> -- mount /mnt/restic      # long-running; Ctrl-C unmounts
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
ambb agent inspect 4f3c1a2b-...
ambb job list
ambb job inspect 9a1b...
ambb --output-format json target list
ambb -o text target inspect <id>
ambb job run 9a1b...
```

## Exit codes

- `0` — success
- `1` — runtime error (network failure, API error, etc.)
- `2` — usage error (unknown command/flag, missing argument)
