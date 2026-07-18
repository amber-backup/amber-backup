# AGENTS.md

Guidance for AI coding agents working on **Amber Backup**.

## Project overview

Amber Backup is a central web dashboard for managing [Restic](https://restic.net) backups across local and remote hosts. It has three parts in one repository:

- **`server/`** — NestJS 11 API, job scheduler, database migration runner, and static host for the SPA.
- **`client/`** — React 19 single-page application built with Vite; served by the server in production.
- **`agent/`** — Lightweight Go agent that runs on remote hosts, enrolls with the server, polls for backup/restore tasks, and executes restic locally.

`server/` and `client/` are npm workspaces under the root `package.json`. `agent/` is a separate Go module and is **not** part of the npm workspace.

## Repository layout

```
.
├── package.json            # npm workspaces root; version bumped by semantic-release
├── package-lock.json
├── docker-compose.dev.yml  # PostgreSQL only, for development
├── docker-compose.yml      # Production stack: PostgreSQL + app image
├── Dockerfile              # Multi-stage build for server + client + agent binaries
├── .releaserc.json         # semantic-release config
├── .github/workflows/      # Docker image publishing
├── README.md               # Human-facing quick-start and feature docs
├── CLAUDE.md               # Claude Code specific guidance
├── server/
│   ├── package.json
│   ├── src/
│   │   ├── main.ts                 # Bootstrap, Swagger, shutdown hooks
│   │   ├── app.module.ts           # Feature module wiring
│   │   ├── config/configuration.ts # Typed env-var config + validation
│   │   ├── database/               # Kysely setup, migrations, types, seed
│   │   ├── crypto/                 # AES-256-GCM encryption service
│   │   ├── restic/                 # Local restic execution service
│   │   ├── common/                 # Guards, decorators, middleware, auth helpers
│   │   ├── auth/                   # Local login, JWT sessions, API keys, users
│   │   ├── targets/                # Backup backend definitions and health checks
│   │   ├── repositories/           # Restic repository metadata
│   │   ├── jobs/                   # Cron-scheduled backup jobs
│   │   ├── runs/                   # Backup run records and orchestration
│   │   ├── restore/                # Snapshot browsing and restore orchestration
│   │   ├── agents/                 # Agent enrollment, polling, task dispatch
│   │   ├── notifications/          # Email/webhook/Slack/Teams/etc. alerts
│   │   ├── reports/                # Dashboard reports
│   │   ├── settings/               # Admin-configurable runtime settings
│   │   ├── audit/                  # Audit log recording and querying
│   │   └── testing/                # Shared test utilities
│   └── .env.example
├── client/
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   ├── public/             # PWA manifest, service worker, icons
│   └── src/
│       ├── main.tsx        # React mount + service worker registration
│       ├── App.tsx         # Router, auth gate, providers
│       ├── core/           # API client, auth context, helpers, types
│       ├── hooks/          # useAsync data loader
│       ├── ui/             # Toast, modal, primitives, backend form fields
│       ├── layout/         # Shell with sidebar
│       ├── pages/          # One file per screen
│       └── styles.css      # Amber dark theme design system
└── agent/
    ├── go.mod
    ├── VERSION             # Agent version; kept in sync with root package.json
    ├── main.go             # Enroll, poll loop, task queue, result reporting
    ├── restic.go           # Restic execution and credential file handling
    ├── types.go            # Task/result types shared with the server
    ├── update.go           # Self-update mechanism
    ├── update_test.go      # Go tests for self-update
    └── Dockerfile          # Standalone agent image
```

## Technology stack

- **Server**: Node.js ≥22, NestJS 11, TypeScript 5, Kysely (query builder), PostgreSQL 17, `pg`, `@nestjs/schedule`, `@nestjs/swagger`, `argon2`, `class-validator`/`class-transformer`, `nodemailer`, `otplib`, `qrcode`, `@simplewebauthn/server`, Jest.
- **Client**: React 19, React Router 7, Vite 6, TypeScript 5, hand-rolled PWA service worker.
- **Agent**: Go 1.25, standard library only, `ed25519` keypair for enrollment.
- **Runtime dependency**: Restic 0.17.3 (bundled in Docker images; dev uses the host `restic` binary).
- **CI/CD**: GitHub Actions building multi-arch (`linux/amd64`, `linux/arm64`) Docker images for `devpatf/amber-backup` and `devpatf/amber-backup-agent`.
- **Release**: `semantic-release` on the `main` branch, version tags `v*.*.*`; updates `package.json`, `package-lock.json`, `agent/VERSION`, and `CHANGELOG.md`.

## Development setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start PostgreSQL:
   ```bash
   docker compose -f docker-compose.dev.yml up -d
   ```
3. Configure the server:
   ```bash
   cp server/.env.example server/.env
   # Fill in MASTER_ENCRYPTION_KEY (32 bytes base64) and JWT_SECRET (base64).
   # openssl rand -base64 32
   # openssl rand -base64 48
   ```
4. Apply migrations:
   ```bash
   npm run migrate --workspace server
   ```
5. Run both server and client:
   ```bash
   npm run dev
   ```

- API / Swagger: http://localhost:3000/api/explorer
- Client dev server: http://localhost:5173 (proxies `/api` to the server)
- First boot creates the bootstrap admin from `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`.
- Restic must be on `PATH` unless overridden with `RESTIC_BINARY`.

## Build and test commands

Run from the repository root unless noted.

```bash
npm run dev                         # server + client concurrently
npm run dev:server                  # NestJS watch mode on :3000
npm run dev:client                  # Vite on :5173
npm run build                       # build server, then client
npm run migrate --workspace server  # apply DB migrations
npm run lint                        # ESLint --fix over server/src
npm run release:dry                 # semantic-release dry run
```

Server-only (from `server/` or with `--workspace server`):

```bash
npm test                            # Jest, all *.spec.ts under src/
npm test -- path/to.spec.ts        # single test file
npm test -- -t "name substring"    # tests matching a name
npm run migrate:down                # roll back the last migration
npm run seed                        # seed development data
npm run start:debug                 # nest start --debug --watch
```

Agent (from `agent/`):

```bash
go build -o bin/amber-agent .       # binary
go test ./...                       # Go tests
docker build -t amber-agent .       # image
```

## Architecture

### Server (NestJS)

`AppModule` wires standard Nest feature modules: `auth`, `targets`, `repositories`, `jobs`, `runs`, `restore`, `agents`, `notifications`, `reports`, `settings`, `audit`, plus shared `database`, `crypto`, `restic`, `config`, `common`, and `static`.

Important cross-cutting details:

- **Migrations run on startup.** `main.ts` calls `runMigrations('up')` *before* `NestFactory.create`, so the schema exists before module initialization. The same `runMigrations` backs the standalone `migrate.ts` CLI.
- **Migrations are Kysely `FileMigrationProvider` files** in `server/src/database/migrations/`. They are loaded from `dist/database/migrations` at runtime, so they must compile to JavaScript.
- **Database access is Kysely, not an ORM.** Inject the typed builder with `@Inject(KYSELY) private readonly db: Db`. The schema type is hand-written in `database/database.types.ts` and must be kept in sync with migrations manually.
- **Secrets at rest are envelope-encrypted.** `CryptoService` (`crypto/crypto.service.ts`) uses AES-256-GCM with the 32-byte `MASTER_ENCRYPTION_KEY`. Repo passwords, backend credentials, notification credentials, OIDC client secrets, and TOTP secrets are stored encrypted. They are only decrypted when handing a task to restic or to an agent.
- **Local restic execution** is handled by `ResticService` (`restic/restic.service.ts`). It builds the process environment, writes temporary credential files, streams JSON output line-by-line, and cleans up transient secrets.
- **Agent dispatch is poll-based.** Agents enroll with a one-time token, then poll `/api/agents/me/poll` for `AgentTask`s. The server hands decrypted repository credentials only over the authenticated agent channel. Offline detection is a scheduled `@Interval` in `agents.service.ts` driven by the admin-configurable agent offline timeout.
- **Auth & RBAC.** Cookie-based JWT session auth plus API-key auth. `common/guards/auth.guard.ts` protects human/API-key routes; `common/guards/agent-auth.guard.ts` protects the agent channel. Mark public routes with `@Public()` (`common/decorators/public.decorator.ts`). Read the caller with `@CurrentUser()`. Grants are per-resource (`view`/`operate`/`manage`); API keys carry restrictable scopes. SSO (generic OIDC, Microsoft Entra ID, Google, GitHub) is configured by admins in the UI and requires admin approval for new users.
- **WebAuthn / passkeys** are supported for passwordless login; `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS` derive from `PUBLIC_BASE_URL` by default.
- **Audit logging.** `AuditService` records every state-changing action (writes and operations like backups, restores, deletes, settings changes, logins). Request secrets are redacted. Entries are retained for `AUDIT_RETENTION_DAYS` (default 90; ≤0 keeps forever).
- **Global `ValidationPipe`** runs with `whitelist: true` and `forbidNonWhitelisted: true`. Every request body must have a matching `class-validator` DTO; unknown properties are rejected, not silently stripped.
- **Static SPA hosting.** `static.module.ts` serves the built client from `/app/client` in production and returns `index.html` for non-API routes (the client uses hash-based routing, so no special fallback is needed).

### Client (React SPA)

- React 19 + Vite, intentionally light on dependencies (`react`, `react-dom`, `react-router-dom`, plus `@simplewebauthn/browser` for passkeys).
- `core/api.ts` is a typed `fetch` wrapper that hits `/api` with cookie credentials and throws `ApiError` on non-OK responses. It also holds shared domain TypeScript types.
- `core/auth.tsx` provides `AuthProvider`/`useAuth` for login state and admin checks.
- `hooks/useAsync.ts` is the standard data loader used by pages: `{ data, loading, error, reload }`.
- `ui/modal.tsx` supports stacked modals; each modal has its own backdrop. `ui/primitives.tsx` contains reusable layout components.
- Pages live in `pages/*.tsx` and are wired into `App.tsx` routes plus the `NAV` array in `layout/Shell.tsx`.
- The app is a PWA: `public/manifest.webmanifest` + `public/sw.js`. The service worker precaches the app shell, serves `/assets/*` cache-first, navigations network-first, and never caches `/api`. Bump `CACHE_VERSION` in `sw.js` when its strategy changes.

### Agent (Go)

- `main.go` handles enrollment, state persistence in `state.json`, the poll loop, task queue, and result reporting.
- `restic.go` mirrors the server's restic execution: builds env, writes credential files, substitutes `{{credentialFile:NAME}}` placeholders, streams JSON output.
- `types.go` defines the JSON task/result shapes that must stay in sync with the server's `AgentTask` / task DTOs.
- `update.go` implements self-updates by downloading a new binary, verifying it, and re-executing.
- The agent executes tasks serially in a worker goroutine but continues polling (heartbeat) while tasks run.
- Binary agents use the host's system restic; the Docker agent bundles a pinned one.

## Code style and conventions

- Server code follows standard NestJS patterns: one module/controller/service triad per feature, DTOs in `dto/`, dependency injection, and `class-validator` decorators.
- Prefer explicit types. The Kysely `Database` interface in `database/database.types.ts` is the source of truth for table shapes; update it when migrations change the schema.
- Do not log or persist plaintext secrets. Decrypt credentials only at the point of use and clean up temporary credential files immediately after restic exits.
- When changing agent task shapes, update both the server (`AgentTask`, `database.types.ts`) and the Go agent (`types.go`, `restic.go`).
- Client pages use `useAsync` for data loading and call `reload()` after mutations. Editor dialogs accept an `onSaved` callback.
- Keep the client dependency tree small; avoid adding new runtime libraries unless necessary.
- Go code in `agent/` uses only the standard library.

## Testing strategy

- **Server**: Jest with `ts-jest`, test files named `*.spec.ts`. Run with `npm test --workspace server`. Tests exist for auth, agents, targets, restore, settings, audit, crypto, config, guards, and middleware.
- **Agent**: Go tests in `agent/update_test.go`. Run with `go test ./...` from `agent/`.
- **Client**: There is currently no lint or test setup for the client; rely on TypeScript (`tsc`) and the Vite build.
- **Integration**: The project does not appear to have end-to-end tests. Manual validation uses `npm run dev` against the local PostgreSQL container.

## Security considerations

- `MASTER_ENCRYPTION_KEY` and `JWT_SECRET` are mandatory and validated at boot. The master key must decode to exactly 32 bytes.
- Never commit `.env` files. `.env.example` files document available variables.
- Secrets are encrypted at rest with AES-256-GCM and redacted from audit logs.
- Agent enrollment uses one-time tokens; after enrollment the agent persists an `AgentKey` and authenticates with bearer tokens.
- Session cookies default to `Secure` only when `PUBLIC_BASE_URL` is `https://`. For plain-HTTP dev or reverse-proxy setups, set `COOKIE_SECURE` explicitly.
- The server runs as PID 1 in a container; `main.ts` registers shutdown hooks and a failsafe timer for SIGTERM/SIGINT.

## Deployment and release

- **Production Docker**: `docker-compose.yml` runs PostgreSQL + the `devpatf/amber-backup` image. Copy `.env.example` to `.env`, fill in the secrets, and run `docker compose up -d`. Migrations apply automatically on startup.
- **Standalone image**: `docker run -p 3000:3000 -e ... devpatf/amber-backup`. The image bundles restic and the agent binaries.
- **Agent rollout**: From the UI, generate an enrollment token and run the displayed install command, or use the `devpatf/amber-backup-agent` image.
- **Release flow**: `semantic-release` runs on `main`, creates a version tag `v*.*.*`, updates `package.json`/`package-lock.json`/`agent/VERSION`/`CHANGELOG.md`, and pushes. The GitHub Actions workflow then builds and publishes multi-arch Docker images to Docker Hub.

## Handy references

- Server env vars: `server/.env.example`
- Docker stack env vars: `.env.example`
- API explorer (when running): `/api/explorer`
- Root README: `README.md`
- Claude-specific notes: `CLAUDE.md`
