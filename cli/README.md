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
ambb target list               List connections (shared backends)
ambb target inspect <id>       Show a single target
```

`repo inspect` reports the repository's deduplicated size and snapshot count,
read live from restic; on an unreachable repository both are `null` and a
`stats_error` field explains why.

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
