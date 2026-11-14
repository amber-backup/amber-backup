import { RawBuilder, sql } from 'kysely';
import { loadConfig } from '../config/configuration';

/**
 * Run errors and timing rules of the lease on work handed to agents
 * (migration 027). Shared by the agent, Proxmox and run services.
 */

/** A poll's task list no longer holds a task claimed before the previous poll. */
export const AGENT_LOST_TASK_MESSAGE = 'The agent restarted or lost this task.';

/** No progress, task-state check or poll mentioned the task for too long. */
export const AGENT_STOPPED_REPORTING_MESSAGE = 'The agent stopped reporting on this task.';

/** A run this server executed itself was still `running` when the server started. */
export const SERVER_RESTART_MESSAGE = 'Interrupted by a server restart.';

/** A queued restore its agent never picked up. */
export const RESTORE_NOT_PICKED_UP_MESSAGE =
  'The agent did not pick up this restore in time — it was discarded so it cannot run later unexpectedly.';

/**
 * Errors of runs the server gave up on while the agent may still have been
 * working on them. A result that arrives later is still recorded.
 */
export const LEASE_EXPIRED_MESSAGES = [AGENT_LOST_TASK_MESSAGE, AGENT_STOPPED_REPORTING_MESSAGE];

/**
 * Stand-in for "never" (about 50 years) where a lease is switched off for
 * older agents. The SQL compares it as a Postgres `int`, so every lease is
 * kept below 2^31 seconds.
 */
const NEVER_SECONDS = 1_576_800_000;

/** Poll interval assumed for an agent whose interval is unknown. */
const DEFAULT_POLL_INTERVAL_SECONDS = 30;

/**
 * How long to wait for an agent that only checks in every `pollInterval`
 * seconds: at least two polls plus a minute, so a healthy agent with a long
 * interval is never mistaken for a missing one.
 */
export function agentWaitSeconds(configured: number, pollInterval: number | null | undefined): number {
  return Math.max(configured, 2 * (pollInterval ?? DEFAULT_POLL_INTERVAL_SECONDS) + 60);
}

/** SQL twin of `agentWaitSeconds` for a poll-interval column (null → configured). */
export function agentWaitSql(configured: number, pollIntervalColumn: string): RawBuilder<number> {
  const seconds = Math.min(Math.trunc(configured), NEVER_SECONDS);
  return sql<number>`greatest(${seconds}::int, coalesce(2 * ${sql.ref(pollIntervalColumn)} + 60, 0))`;
}

export interface LeaseTimeouts {
  /** Lease for agents that list their tasks in the poll. */
  heartbeatSeconds: number;
  /** Lease for older agents. */
  legacySeconds: number;
}

/** The configured leases; null when the lease sweep is switched off. */
export function configuredLeaseTimeouts(): LeaseTimeouts | null {
  const config = loadConfig();
  if (config.agentTaskHeartbeatTimeoutSeconds <= 0) return null;
  return {
    heartbeatSeconds: Math.min(config.agentTaskHeartbeatTimeoutSeconds, NEVER_SECONDS),
    legacySeconds:
      config.agentTaskLegacyTimeoutSeconds > 0
        ? Math.min(config.agentTaskLegacyTimeoutSeconds, NEVER_SECONDS)
        : NEVER_SECONDS,
  };
}

/**
 * Whether the `running` row of `table` (alias) held by the agent `agents`
 * (alias) has outlived its lease: its last sign of life — never earlier than
 * this server's start, so a server that was down does not fail everything at
 * once — is older than the agent's lease.
 */
export function leaseExpiredSql(
  table: string,
  agents: string,
  timeouts: LeaseTimeouts,
  now: Date,
  serverStartedAt: Date,
): RawBuilder<boolean> {
  const lease = sql`case when ${sql.ref(`${agents}.reports_running_tasks`)}
      then greatest(${Math.trunc(timeouts.heartbeatSeconds)}::int, 2 * ${sql.ref(`${agents}.poll_interval_seconds`)} + 60)
      else ${Math.trunc(timeouts.legacySeconds)}::int end`;
  return sql<boolean>`greatest(coalesce(${sql.ref(`${table}.heartbeat_at`)}, ${sql.ref(`${table}.started_at`)}), ${serverStartedAt}::timestamptz)
    < ${now}::timestamptz - (${lease}) * interval '1 second'`;
}

/** Run ids are uuids; anything else (e.g. a stats task id) is no run row. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The entries of a poll's task list that can be run ids (safe to compare with a uuid column). */
export function runIds(taskIds: string[], prefix = ''): string[] {
  return taskIds
    .filter((id) => id.startsWith(prefix))
    .map((id) => id.slice(prefix.length))
    .filter((id) => UUID_RE.test(id));
}
