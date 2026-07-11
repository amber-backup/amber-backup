# Amber Backup

Central dashboard for managing [Restic](https://restic.net) backups across local
and remote servers — configure, schedule, run, monitor and restore backups from
one place. Remote hosts are covered by a lightweight Go agent.

## Features

- **Dashboard** — recent runs, upcoming schedules, agent/fleet status, activity log.
- **Targets** — every restic backend (local, SFTP, REST, S3, B2, Azure, GCS, Swift, rclone) via a dynamic, schema-driven form, with a connection test.
- **Sources** — local (server) or agent-bound path sets.
- **Jobs** — cron-scheduled backups with full restic options and integrated retention (`forget`/`prune`).
- **Restore** — live snapshot browsing (`snapshots` + `ls`), selective or full restore in three modes (original / alternate path / download archive), dry-run and overwrite safety.
- **Agents** — enrollment tokens + install command, poll-based task dispatch, heartbeat/offline detection, reported restic version.
- **Notifications** — per-job success/failure alerts via Email (SMTP), generic webhook, Slack, Microsoft Teams, Discord, Telegram, Gotify and ntfy.
- **Auth & RBAC** — local login (Argon2), session JWT, API keys with restrictable scopes, per-resource grants (view/operate/manage), and SSO with admin approval for new users: enable single sign-on and add any number of providers (generic OIDC, Microsoft Entra ID, Google, GitHub).
- **Audit log** — every state-changing action by users, admins and API keys (writes and operations like backups, restores, deletes, settings and logins) is recorded and browsable in a paginated, filterable admin table with per-entry drill-down; request secrets are redacted. Entries are retained for `AUDIT_RETENTION_DAYS` (default 90; `0` keeps them forever).
- **Security** — AES-256-GCM encryption of repo passwords and backend credentials at rest; credentials handed to agents only over the authenticated channel.

## Quick start (development)

```bash
# 1. Dependencies
npm install

# 2. PostgreSQL
docker compose -f docker-compose.dev.yml up -d

# 3. Server env
cp server/.env.example server/.env
# Fill in MASTER_ENCRYPTION_KEY and JWT_SECRET:
#   openssl rand -base64 32   # MASTER_ENCRYPTION_KEY (must be 32 bytes)
#   openssl rand -base64 48   # JWT_SECRET

# 4. Migrate
npm run migrate --workspace server

# 5. Run server + client (proxied)
npm run dev
```

- Client dev server: <http://localhost:5173> (proxies `/api` to the server)
- Server + API: <http://localhost:3000>, Swagger at `/api/explorer`
- First start creates the bootstrap admin from `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`.

Restic must be on `PATH` in dev (`RESTIC_BINARY` to override).

## Production (Docker)

```bash
docker run -d --name amber-backup \
  -p 3000:3000 \
  -e DATABASE_URL=postgres://amber:amber@db:5432/amber \
  -e MASTER_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -e JWT_SECRET="$(openssl rand -base64 48)" \
  -e PUBLIC_BASE_URL=https://backup.example.com \
  -e BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  -e BOOTSTRAP_ADMIN_PASSWORD=change-me \
  -v amber-data:/data \
  devpatf/amber-backup
```

The image bundles a pinned restic (`RESTIC_VERSION` build arg) and serves both the
API and the SPA on port 3000. Pending database migrations are applied
automatically on startup (the standalone `dist/database/migrate.js up` remains
available for manual/CI use).

For a full stack (app + PostgreSQL) use the provided `docker-compose.yml`:

```bash
cp .env.example .env   # then fill in the secrets
docker compose up -d
```

TLS is expected to be terminated by a reverse proxy in front of the container.

## Agents

From **Agent → Roll out agent**, generate an enrollment token. Run the shown
command on the target host:

```bash
# Binary (systemd)
curl -sSL https://backup.example.com/api/agents/install.sh | AMBER_URL=https://backup.example.com AMBER_TOKEN=<token> sh

# Docker
docker run -d --restart unless-stopped \
  -e AMBER_URL=https://backup.example.com -e AMBER_TOKEN=<token> \
  -v amber-agent:/var/lib/amber-agent \
  devpatf/amber-backup-agent:latest
```

The agent enrolls, then polls for backup/restore tasks and runs restic locally.
Binary agents use the host's system restic; the Docker agent bundles a pinned one.

Build the agent locally:

```bash
cd agent && go build -o bin/amber-agent .      # binary
docker build -t amber-agent ./agent            # image
```

## Configuration

Core configuration is via environment variables — see `server/.env.example` for
the full list (database, encryption key, JWT, restic paths, audit log retention,
bootstrap admin).

Runtime settings that admins can change without a restart live in the **Admin**
section of the UI and are stored in the database: the agent offline timeout and
the single sign-on configuration — a master toggle plus any number of providers
(generic OIDC, Microsoft Entra ID, Google, GitHub); client secrets are encrypted
at rest.

## License

Licensed under the [Apache License 2.0](LICENSE).
