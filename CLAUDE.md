# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Never commit on your own

Do not run `git commit`, `git push`, or otherwise create commits unless the user
explicitly asks you to in that message. Making changes to files is fine; turning
them into commits is the user's decision. This overrides any default instinct to
commit finished work.

## What this is

Amber Backup is a central dashboard for managing [Restic](https://restic.net)
backups across local and remote hosts. Three parts, one repo:

- **`server/`** — NestJS 11 API + scheduler + static SPA host (TypeScript).
- **`client/`** — framework-less TypeScript SPA built with Vite.
- **`agent/`** — lightweight Go agent that runs on remote hosts, polls the
  server for tasks, and executes restic locally.

`server` and `client` are npm workspaces (root `package.json`); `agent` is a
separate Go module and is **not** part of the npm workspace.

## Commands

Run from the repo root unless noted. `npm run <x>` at root delegates to workspaces.

```bash
npm install                      # install server + client deps
docker compose -f docker-compose.dev.yml up -d   # local PostgreSQL
npm run migrate --workspace server               # apply DB migrations
npm run dev                      # server (:3000) + client (:5173) concurrently
npm run build                    # build server then client
npm run lint                     # eslint --fix over server/src (client has no lint)
```

Server-only (from `server/`, or `--workspace server`):

```bash
npm test                         # jest (all tests)
npm test -- path/to.spec.ts      # single test file
npm test -- -t "name substring"  # tests matching a name
npm run migrate:down             # roll back last migration
npm run seed                     # seed dev data
npm run start:debug              # nest --debug --watch
```

Agent (from `agent/`):

```bash
go build -o bin/amber-agent .    # binary
docker build -t amber-agent .    # image
```

Dev requires `restic` on `PATH` (override with `RESTIC_BINARY`). Client dev
server proxies `/api` to `:3000`. Swagger UI is at `/api/explorer`.

## Configuration

All config is environment variables — see `server/.env.example` for the full
list. Two secrets are mandatory and validated on boot: `MASTER_ENCRYPTION_KEY`
(base64 of exactly 32 bytes) and `JWT_SECRET`. Copy `server/.env.example` to
`server/.env` for dev.

## Architecture

### Server (NestJS)

`AppModule` wires feature modules, each a standard Nest module/controller/service
triad under `server/src/<feature>/`: `auth`, `targets`, `jobs`, `runs`,
`restore`, `agents`, `notifications`, plus shared `crypto`, `restic`, `database`,
`common`, `config`.

Key cross-cutting flows to understand before editing:

- **Migrations run on startup.** `main.ts` calls `runMigrations('up', …)` in
  `bootstrap()` *before* `NestFactory.create`, so the schema exists before module
  init (e.g. bootstrap-admin creation). The same `runMigrations` (in
  `database/migrator.ts`) backs the standalone CLI. Migrations live in
  `database/migrations/NNN_*.ts` and are loaded from `dist/database/migrations`
  at runtime — they must compile to JS.

- **Database access is Kysely, not an ORM.** Inject the typed builder via
  `@Inject(KYSELY) private readonly db: Db`. The full schema type is hand-written
  in `database/database.types.ts` (`Database` interface) and must be kept in sync
  with migrations by hand.

- **Secrets at rest are envelope-encrypted.** `CryptoService`
  (`crypto/crypto.service.ts`) does AES-256-GCM with the env master key. Repo
  passwords and backend credentials are stored encrypted and only decrypted when
  handing a task to restic or to an agent. Never log or persist plaintext secrets.

- **Restic execution.** `ResticService` (`restic/restic.service.ts`) spawns the
  restic process for local runs: builds the env (repository, password, backend
  credential temp files), streams JSON output line-by-line, cleans up transient
  secrets. The Go agent mirrors this logic for remote hosts — changes to run
  behavior often need to be made in both `restic/restic.service.ts` and
  `agent/restic.go`.

- **Agent dispatch is poll-based.** Agents enroll with a token, then poll
  `agent-api.controller.ts` for `AgentTask`s (backup/restore). The server hands
  over decrypted repository credentials only over the authenticated agent
  channel. Offline detection is a scheduled `@Interval` in `agents.service.ts`
  driven by `AGENT_OFFLINE_TIMEOUT_SECONDS`. `AgentTask` in `agents.service.ts`
  is the shared contract between server and Go agent.

- **Auth & RBAC.** Cookie/JWT session auth. `common/guards/auth.guard.ts`
  protects human/API-key requests; `agent-auth.guard.ts` protects the agent
  channel. Mark public routes with the `@Public()` decorator
  (`common/decorators/public.decorator.ts`); read the caller via `@CurrentUser()`.
  Grants are per-resource (view/operate/manage); API keys carry restrictable
  scopes. OIDC + Microsoft Entra SSO with admin approval for new users.

- **Global `ValidationPipe`** runs with `whitelist` + `forbidNonWhitelisted`, so
  every request body needs a `class-validator` DTO (see each feature's `dto/`).
  Unlisted properties are rejected, not stripped silently.

### Client (framework-less SPA)

No React/Vue. UI is built with a tiny hyperscript helper `h(tag, attrs, …children)`
in `core/dom.ts`. Structure:

- `main.ts` — boots, refreshes auth, registers hash routes, renders the shell.
- `core/router.ts` — hash-based router (`#/path`, `:param` segments).
- `core/api.ts` — typed `fetch` wrapper; all calls hit `/api`, cookie auth
  (`credentials: 'include'`), throws `ApiError` on non-OK.
- `core/auth.ts`, `core/layout.ts`, `core/ui.ts`, `core/icons.ts` — session
  state, app shell, shared UI widgets, icons.
- `pages/*.ts` — one `render<Page>()` per screen, registered as a route in
  `main.ts`.

Adding a page = new `pages/x.ts` exporting a render function + a route entry in
`main.ts`. The SPA is served by the Nest server in production (`static.module.ts`);
in dev Vite proxies `/api`.

### Agent (Go)

Single small module in `agent/`: `main.go` (enroll + poll loop), `restic.go`
(restic execution), `types.go` (task/result shapes mirroring the server's
`AgentTask`). Binary agents use the host's system restic; the Docker agent
bundles a pinned one.

## Conventions

- The NestJS server follows solutec NestJS conventions — when scaffolding or
  restructuring server code (controllers/services/modules/DTOs, DI, Swagger),
  consult the `nestjs-conventions` skill.
- When editing task/credential shapes, keep the server (`AgentTask`,
  `database.types.ts`) and the Go agent (`types.go`, `restic.go`) in sync.
