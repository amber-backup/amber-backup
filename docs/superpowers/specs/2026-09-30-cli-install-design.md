# Install the `ambb` CLI via a one-liner served by the Amber server

Date: 2026-09-30 · Status: approved

## Goal

Users can install the `ambb` CLI with a single command copied from the Amber
web UI, then pair it with `ambb login <server>`. The server hands out install
scripts only; the binaries keep coming from GitHub Releases.

## Non-goals

- Bundling CLI binaries into the Docker image or serving them from the server.
- Air-gapped installs (the installing machine needs access to github.com).
- Package-manager integration (brew, winget, …).

## Design

### Install scripts (`cli/install.sh`, `cli/install.ps1`)

Real files in the repo that also work standalone (e.g. from a raw GitHub URL).

Common behaviour:

- Defaults from the environment: `AMBB_VERSION` (default `latest`, `v` prefix
  optional), `AMBB_INSTALL_DIR`, `AMBER_URL` (only used for the final hint).
- `latest` is resolved to a concrete release tag, because asset names contain
  the version.
- Downloads `ambb_<version>_<os>_<arch>.tar.gz` (`.zip` on Windows) and
  `checksums.txt` over HTTPS from
  `https://github.com/amber-backup/amber-backup/releases/download/v<version>/`.
- Verifies the archive's SHA-256 against `checksums.txt`; a missing entry or a
  mismatch aborts the install.
- Extracts into a temp dir (always cleaned up) and installs the binary.
- Prints `ambb --version` and the next step `ambb login <AMBER_URL>`.

`install.sh` (POSIX sh, Linux + macOS): `set -eu`, no bashisms, the body is a
function called on the last line so a truncated `curl | sh` download never runs
half a script. `curl` (`--proto =https`) or `wget`; `sha256sum` or
`shasum -a 256`. Install dir: `$AMBB_INSTALL_DIR`, else `/usr/local/bin` when
root or writable, else `~/.local/bin`; warns when the dir is not on `PATH`.

`install.ps1` (Windows PowerShell 5.1 + PowerShell 7): run via
`irm … | iex`, so the whole script is one script block that `throw`s on errors
and never calls `exit` (which would close the user's shell). Forces TLS 1.2 on
5.1, resolves `latest` via the GitHub API, verifies with `Get-FileHash`,
installs to `$env:AMBB_INSTALL_DIR` or `%LOCALAPPDATA%\Programs\ambb`, and adds
that dir to the user `PATH` and the current session.

Each script defines its server-substitutable defaults on single, exact marker
lines, e.g. `AMBB_VERSION="${AMBB_VERSION:-latest}"`. An explicitly set
environment variable always wins over the (substituted) default.

### Server

- Config `cliScriptDir` (env `CLI_SCRIPT_DIR`). Default resolves to the repo's
  `cli/` directory relative to the compiled code (dev); the Docker image copies
  both scripts to `/app/cli-install` and sets `CLI_SCRIPT_DIR` there.
- New `cli` feature module with two `@Public()` routes:
  `GET /api/cli/install.sh` and `GET /api/cli/install.ps1`
  (`text/plain; charset=utf-8`, `Cache-Control: no-store`).
- The service reads the script and substitutes the marker lines with the
  server's version (the image's bundled `agent-bin/version`, shared helper with
  the agent self-update) and `PUBLIC_BASE_URL` (trailing slash stripped).
- Values are validated before injection: version `^\d+\.\d+\.\d+$`, URL
  `^https?://[A-Za-z0-9.-]+(:\d+)?(/[A-Za-z0-9._~/-]*)?$`. An invalid or unknown
  value leaves that default untouched, so no shell/PowerShell injection is
  possible.
- Missing script file → 404. Missing marker line → 500 + error log (never serve a
  script silently without its defaults).

### Client

Settings gets a "Command line (ambb)" panel directly above the API keys panel:
OS switch (Linux/macOS | Windows, preselected from the user agent), step 1 the
install one-liner for `window.location.origin`, step 2 `ambb login <origin>`
(both copyable), and hints on `ambb update` and the matching GitHub release for
a manual download. All strings in English and German.

### Docs

`cli/README.md` gets an "Install" section (one-liners, env overrides, what the
script verifies, `gh attestation verify`). `CLAUDE.md` mentions the endpoints
and the config value.

## Testing

- Jest: substitution, rejection of malicious values, missing file, missing
  marker.
- `sh -n` / dash; real install against GitHub (pinned and latest), and the
  server-substituted script piped into `sh`; checksum-mismatch negative test.
- `install.ps1` is reviewed only (no PowerShell available on the dev machine).
