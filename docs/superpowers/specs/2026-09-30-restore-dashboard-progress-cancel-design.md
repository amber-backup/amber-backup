# Restores in the dashboard feed, restore progress, and real agent-side cancel

Date: 2026-09-30 · Status: approved

## Problem

- Restores live in `restore_runs`; the dashboard feed reads only `job_runs`
  (`GET /runs`), so restores never show up there.
- Restore progress only stores `percentDone`; restic's byte/file counters are
  dropped (server and agent).
- A running agent restore cannot be cancelled at all. Cancelling a running agent
  backup only marks the row — restic keeps running on the host, because the Go
  agent has no cancel mechanism.

## Design

### Server – activity feed

- `RunsService.list` selects `job_runs` and `restore_runs` in one `UNION ALL`,
  wrapped in an outer select ordered by `created_at desc, id desc` with
  limit/offset, so offset pagination (infinite scroll) keeps working.
- Restore rows use the job-run column shape: `kind = 'restore'`,
  `parent_run_id / check_info / retry_of_run_id / not_before / forget_result =
  null`, `attempt = 1`, `trigger = 'manual'`, `job_name` via LEFT JOIN on
  `backup_jobs` (null when the job was deleted), `target_id` from the restore
  row. A new column `restore_mode` carries `restore_runs.mode` (null for job
  runs). Literal nulls are cast to the job-run column types.
- ACL as in `RestoreService`: restores of visible jobs; restores whose job was
  deleted (`job_id null`) only for admins (`visibleResourceIds === 'all'`).
- `kind` accepts a comma list (`backup,restore`); `jobId` / `status` filter both
  sides. An excluded side gets a constant `false` predicate.
- `dashboard().running` counts restores automatically (it reads `list`); the
  success/failed counters stay backup-only.

### Server – restore progress

- `ResticService.restore` maps restic `status` lines to `percentDone`,
  `bytesDone = bytes_restored + bytes_skipped`, `totalBytes`,
  `filesDone = files_restored + files_skipped`, `totalFiles` (skipped files
  count as done, otherwise `--overwrite if-changed` never reaches 100 %). The
  `summary` keeps `totalFilesProcessed / totalBytesProcessed / percentDone: 1`
  and sets the done counters to the totals.
- Local restore progress writes are throttled to about one per second and only
  touch a `running` row; the final result write carries the final stats.

### Server – cancel

- `RestoreService.cancel`: finished → `400`; local running → abort the
  process; otherwise mark `cancelled` — a queued restore without an error, one
  running on an agent with *"Cancelled on the server — the agent may still be
  running this task."* (same wording as `RunsService.cancel`).
- New agent endpoint `GET /api/agents/me/tasks/:id/state` (AgentAuthGuard) →
  `{ cancelled: boolean }`. Looks up the id in `job_runs` / `restore_runs`;
  `cancelled` when the row is `cancelled` or no longer exists; `404` when it
  belongs to another agent (or is not a run id, e.g. a `stats-` task). It
  refreshes the agent's liveness like progress/result posts.
- `TaskResultDto.status` accepts `cancelled`. For backups, restores and checks a
  `cancelled` result settles the row as `cancelled` (an already cancelled row
  keeps its `finished_at`) with `error = 'Cancelled on the agent.'` and the
  agent's log. No retry is queued and no notification fires. Older agents never
  report `cancelled`, so the "may still be running" hint stays for them.

### Go agent

- `resticRunner.run` takes a `context.Context`: `exec.CommandContext` with
  `cmd.Cancel` sending SIGINT (restic then removes its lock) and
  `cmd.WaitDelay = 30s` before a hard kill. All callers pass the task context.
- `runTask` gives every run task a cancellable context and a watcher goroutine
  that polls `GET …/tasks/<id>/state` every 5 s and cancels on
  `cancelled: true`. Errors / 404 (older server) are logged at most once per
  task. `stats` tasks have no run row and are not watched. The state is also
  checked once before a task starts, so a task cancelled while it waited
  behind another one is reported `cancelled` without running.
- Backup on cancel: stop at once — no forget/prune, no stats read, no
  post-success script. The post-failure script still runs (it often restarts
  services the pre-script stopped) with `AMBER_STATUS=cancelled`, bounded by the
  script timeout and independent of the cancelled context. Cancellation is also
  checked right after the pre-script.
- Restore / check on cancel: report `cancelled`. Cancellation is detected via
  `ctx.Err()`, not exit codes. Result: `TaskResult{Status: "cancelled", Log}`.
- Restore progress posts the backup fields (`percentDone`, `bytesDone`,
  `totalBytes`, `filesDone`, `totalFiles`), throttled to 1 s; the summary maps
  to the same stats as on the server.

### Client

- `Run.kind` gains `'restore'`, plus `restore_mode`.
- Dashboard requests `kind=backup,restore` while maintenance is hidden, and the
  poll filter keeps restores too.
- A stale active restore row is refreshed from `/restores/:id` (only fields of
  `Run` are merged), others from `/runs/:id`.
- Restore rows: badge "Restore", sub line "<mode> · <snapshot>"; running shows
  the shared progress bar (percent + bytes done / total); success shows the
  restored size, duration and relative time; cancel posts to
  `/restores/:id/cancel`.
- New strings in `en` and `de`.

## Out of scope

- Cancelling from the snapshot restore history (it has no cancel button today).
- A DB index for the feed ordering.
