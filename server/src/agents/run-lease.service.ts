import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { sql } from 'kysely';
import { Db, KYSELY } from '../database/database.module';
import { loadConfig } from '../config/configuration';
import { RunRetryService } from '../jobs/run-retry.service';
import { ProxmoxService } from '../proxmox/proxmox.service';
import {
  AGENT_LOST_TASK_MESSAGE,
  AGENT_STOPPED_REPORTING_MESSAGE,
  agentWaitSql,
  configuredLeaseTimeouts,
  leaseExpiredSql,
  RESTORE_NOT_PICKED_UP_MESSAGE,
  runIds,
} from './run-lease';

/** Kinds of job runs handed to an agent as a task of their own. */
const AGENT_RUN_KINDS = ['backup', 'check'] as const;

/**
 * The lease on work handed to agents (migration 027): a `running` row an
 * agent no longer works on is failed and settled instead of staying
 * `running` forever (blocking retries and checks, never notified).
 *
 * - On a poll that lists the agent's tasks (`runningTaskIds`), the tasks it
 *   still holds are renewed, and tasks claimed before its previous poll that
 *   it no longer knows are failed at once (it restarted, or the poll answer
 *   that carried them was lost).
 * - A sweep fails `running` rows whose last sign of life (claim, progress,
 *   task-state check, poll) is older than the agent's lease.
 * - Queued restores expire, so a restore never runs long after the operator
 *   gave up on it.
 *
 * Proxmox guests and finishing tasks follow the same rules in ProxmoxService.
 */
@Injectable()
export class RunLeaseService {
  private readonly logger = new Logger(RunLeaseService.name);
  /** Leases never count from before this process started (the server may have been down). */
  private readonly startedAt = new Date();

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly retries: RunRetryService,
    @Optional() private readonly proxmox?: ProxmoxService,
  ) {}

  /**
   * Applies a poll's task list: renews the tasks the agent still holds and
   * fails those claimed before its previous poll (`previousPollAt`) that it
   * no longer lists. A task claimed since then may still be on its way.
   */
  async reconcile(agentId: string, taskIds: string[], previousPollAt: Date | null): Promise<void> {
    const ids = runIds(taskIds);
    const now = new Date();
    if (ids.length) {
      await this.db
        .updateTable('job_runs')
        .set({ heartbeat_at: now })
        .where('agent_id', '=', agentId)
        .where('status', '=', 'running')
        .where('id', 'in', ids)
        .execute();
      await this.db
        .updateTable('restore_runs')
        .set({ heartbeat_at: now })
        .where('agent_id', '=', agentId)
        .where('status', '=', 'running')
        .where('id', 'in', ids)
        .execute();
    }
    if (this.proxmox) await this.proxmox.renewAgentTasks(agentId, taskIds, now);
    if (!previousPollAt) return;

    let lostRuns = this.db
      .updateTable('job_runs')
      .set({ status: 'failed', finished_at: now, error: AGENT_LOST_TASK_MESSAGE })
      .where('agent_id', '=', agentId)
      .where('status', '=', 'running')
      // A Proxmox run is no task itself; its guests are (ProxmoxService).
      .where('proxmox_phase', 'is', null)
      .where('kind', 'in', [...AGENT_RUN_KINDS])
      .where('started_at', '<', previousPollAt);
    if (ids.length) lostRuns = lostRuns.where('id', 'not in', ids);
    const runs = await lostRuns.returning('id').execute();

    let lostRestores = this.db
      .updateTable('restore_runs')
      .set({ status: 'failed', finished_at: now, error: AGENT_LOST_TASK_MESSAGE })
      .where('agent_id', '=', agentId)
      .where('status', '=', 'running')
      .where('started_at', '<', previousPollAt);
    if (ids.length) lostRestores = lostRestores.where('id', 'not in', ids);
    const restores = await lostRestores.returning('id').execute();

    if (runs.length || restores.length) {
      this.logger.warn(
        `Agent ${agentId} no longer knows ${runs.length + restores.length} task(s): ${[...runs, ...restores].map((r) => r.id).join(', ')}`,
      );
    }
    for (const run of runs) void this.retries.finalize(run.id);
    if (this.proxmox) await this.proxmox.reconcileAgentTasks(agentId, taskIds, previousPollAt);
  }

  @Interval(30_000)
  async sweep(): Promise<void> {
    try {
      await this.failExpiredLeases();
    } catch (e) {
      this.logger.warn(`Lease sweep failed: ${e}`);
    }
    try {
      await this.failStaleQueuedRestores();
    } catch (e) {
      this.logger.warn(`Restore queue sweep failed: ${e}`);
    }
  }

  /** Fails `running` agent runs and restores whose lease expired, and settles them. */
  async failExpiredLeases(): Promise<void> {
    const timeouts = configuredLeaseTimeouts();
    if (!timeouts) return;
    const now = new Date();

    const runs = await this.db
      .updateTable('job_runs')
      .from('agents')
      .set({ status: 'failed', finished_at: now, error: AGENT_STOPPED_REPORTING_MESSAGE })
      .whereRef('agents.id', '=', 'job_runs.agent_id')
      .where('job_runs.status', '=', 'running')
      .where('job_runs.proxmox_phase', 'is', null)
      .where('job_runs.kind', 'in', [...AGENT_RUN_KINDS])
      .where(leaseExpiredSql('job_runs', 'agents', timeouts, now, this.startedAt))
      .returning('job_runs.id')
      .execute();
    const restores = await this.db
      .updateTable('restore_runs')
      .from('agents')
      .set({ status: 'failed', finished_at: now, error: AGENT_STOPPED_REPORTING_MESSAGE })
      .whereRef('agents.id', '=', 'restore_runs.agent_id')
      .where('restore_runs.status', '=', 'running')
      .where(leaseExpiredSql('restore_runs', 'agents', timeouts, now, this.startedAt))
      .returning('restore_runs.id')
      .execute();

    for (const run of runs) {
      this.logger.warn(`Run ${run.id}: the agent stopped reporting on it`);
      void this.retries.finalize(run.id);
    }
    for (const restore of restores) {
      this.logger.warn(`Restore ${restore.id}: the agent stopped reporting on it`);
    }
  }

  /**
   * Discards restores their agent did not pick up in time (an hour by
   * default, at least two poll intervals plus a minute), so a restore cannot
   * overwrite data long after the operator stopped waiting for it.
   */
  async failStaleQueuedRestores(): Promise<void> {
    const timeout = loadConfig().restoreQueueTimeoutSeconds;
    if (timeout <= 0) return;
    const now = new Date();
    const wait = agentWaitSql(timeout, 'agents.poll_interval_seconds');
    const stale = await this.db
      .updateTable('restore_runs')
      .from('agents')
      .set({ status: 'failed', finished_at: now, error: RESTORE_NOT_PICKED_UP_MESSAGE })
      .whereRef('agents.id', '=', 'restore_runs.agent_id')
      .where('restore_runs.status', '=', 'queued')
      .where('restore_runs.created_at', '<', sql<Date>`${now}::timestamptz - ${wait} * interval '1 second'`)
      .returning('restore_runs.id')
      .execute();
    for (const restore of stale) {
      this.logger.warn(`Restore ${restore.id} was not picked up in time and was discarded`);
    }
  }
}
