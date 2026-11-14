import { recordingDb, RecordedQuery } from '../testing/recording-db';
import { RunRetryService } from '../jobs/run-retry.service';
import { ProxmoxService } from '../proxmox/proxmox.service';
import { RunLeaseService } from './run-lease.service';
import { agentWaitSeconds, configuredLeaseTimeouts, runIds } from './run-lease';

const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';

function make(respond: (q: RecordedQuery) => Record<string, unknown>[] = () => []) {
  const { db, queries } = recordingDb(respond);
  const retries = { finalize: jest.fn().mockResolvedValue(undefined) };
  const proxmox = {
    renewAgentTasks: jest.fn().mockResolvedValue(undefined),
    reconcileAgentTasks: jest.fn().mockResolvedValue(undefined),
  };
  const service = new RunLeaseService(
    db,
    retries as unknown as RunRetryService,
    proxmox as unknown as ProxmoxService,
  );
  return { service, queries, retries, proxmox };
}

afterEach(() => {
  delete process.env.AGENT_TASK_HEARTBEAT_TIMEOUT_SECONDS;
  delete process.env.AGENT_TASK_LEGACY_TIMEOUT_SECONDS;
  delete process.env.RESTORE_QUEUE_TIMEOUT_SECONDS;
});

describe('run-lease helpers', () => {
  it('waits at least two poll intervals plus a minute for an agent', () => {
    expect(agentWaitSeconds(300, 30)).toBe(300);
    expect(agentWaitSeconds(300, 600)).toBe(1260);
    expect(agentWaitSeconds(300, null)).toBe(300);
  });

  it('keeps every lease within a Postgres int, also when the legacy lease is switched off', () => {
    const INT_MAX = 2 ** 31 - 1;
    process.env.AGENT_TASK_LEGACY_TIMEOUT_SECONDS = '0';
    expect(configuredLeaseTimeouts()!.legacySeconds).toBeLessThanOrEqual(INT_MAX);
    process.env.AGENT_TASK_LEGACY_TIMEOUT_SECONDS = '99999999999';
    process.env.AGENT_TASK_HEARTBEAT_TIMEOUT_SECONDS = '99999999999';
    const t = configuredLeaseTimeouts()!;
    expect(t.legacySeconds).toBeLessThanOrEqual(INT_MAX);
    expect(t.heartbeatSeconds).toBeLessThanOrEqual(INT_MAX);
    process.env.AGENT_TASK_HEARTBEAT_TIMEOUT_SECONDS = '0';
    expect(configuredLeaseTimeouts()).toBeNull();
  });

  it('keeps only task ids that can be run ids', () => {
    expect(runIds([RUN_A, 'stats-repo-1', `pveret-${RUN_B}`, 'hvinv-x'])).toEqual([RUN_A]);
    expect(runIds([RUN_A, `pveret-${RUN_B}`], 'pveret-')).toEqual([RUN_B]);
  });
});

describe('RunLeaseService.reconcile (task list in the poll)', () => {
  it('renews the tasks the agent holds and fails those claimed before its previous poll that it lost', async () => {
    const previousPoll = new Date(Date.now() - 60_000);
    const { service, queries, retries, proxmox } = make(({ sql }) =>
      sql.includes('returning "id"') && sql.startsWith('update "job_runs"') ? [{ id: RUN_B }] : [],
    );

    await service.reconcile('agent-1', [RUN_A, 'stats-repo-1'], previousPoll);

    const [renewRuns, renewRestores, lostRuns, lostRestores] = queries;
    expect(renewRuns.sql).toBe(
      'update "job_runs" set "heartbeat_at" = $1 where "agent_id" = $2 and "status" = $3 and "id" in ($4)',
    );
    // A stats task id is no uuid and never reaches a uuid comparison.
    expect(renewRuns.parameters).toEqual([expect.any(Date), 'agent-1', 'running', RUN_A]);
    expect(renewRestores.sql).toContain('update "restore_runs" set "heartbeat_at"');
    expect(lostRuns.sql).toBe(
      'update "job_runs" set "status" = $1, "finished_at" = $2, "error" = $3 where "agent_id" = $4 and "status" = $5 and "proxmox_phase" is null and "kind" in ($6, $7) and "started_at" < $8 and "id" not in ($9) returning "id"',
    );
    expect(lostRuns.parameters).toEqual([
      'failed',
      expect.any(Date),
      'The agent restarted or lost this task.',
      'agent-1',
      'running',
      'backup',
      'check',
      previousPoll,
      RUN_A,
    ]);
    expect(lostRestores.sql).toContain('update "restore_runs" set "status" = $1');
    expect(lostRestores.sql).toContain('"started_at" < $6 and "id" not in ($7)');
    // A lost backup is settled like any failed one (retry or notification).
    expect(retries.finalize).toHaveBeenCalledWith(RUN_B);
    expect(proxmox.renewAgentTasks).toHaveBeenCalledWith('agent-1', [RUN_A, 'stats-repo-1'], expect.any(Date));
    expect(proxmox.reconcileAgentTasks).toHaveBeenCalledWith('agent-1', [RUN_A, 'stats-repo-1'], previousPoll);
  });

  it('fails every task claimed before the previous poll when the agent holds none', async () => {
    const previousPoll = new Date(Date.now() - 60_000);
    const { service, queries } = make();

    await service.reconcile('agent-1', [], previousPoll);

    // Nothing to renew; no "not in ()" for an empty list.
    expect(queries.map((q) => q.sql.split(' set ')[0])).toEqual([
      'update "job_runs"',
      'update "restore_runs"',
    ]);
    expect(queries.every((q) => !q.sql.includes('not in'))).toBe(true);
  });

  it('only renews on the first poll (no earlier poll to compare with)', async () => {
    const { service, queries, proxmox } = make();

    await service.reconcile('agent-1', [RUN_A], null);

    expect(queries.every((q) => q.sql.includes('set "heartbeat_at"'))).toBe(true);
    expect(proxmox.reconcileAgentTasks).not.toHaveBeenCalled();
  });
});

describe('RunLeaseService.failExpiredLeases', () => {
  it('fails running agent runs and restores whose lease expired, relative to the agent', async () => {
    const { service, queries, retries } = make(({ sql }) =>
      sql.startsWith('update "job_runs"') ? [{ id: RUN_A }] : [],
    );

    await service.failExpiredLeases();

    const [runs, restores] = queries;
    expect(runs.sql).toContain('update "job_runs" set "status" = $1, "finished_at" = $2, "error" = $3 from "agents"');
    expect(runs.sql).toContain('"agents"."id" = "job_runs"."agent_id"');
    expect(runs.sql).toContain('"job_runs"."proxmox_phase" is null');
    expect(runs.sql).toContain('greatest(coalesce("job_runs"."heartbeat_at", "job_runs"."started_at"), $7::timestamptz)');
    expect(runs.sql).toContain('greatest($9::int, 2 * "agents"."poll_interval_seconds" + 60)');
    expect(runs.sql).toContain('case when "agents"."reports_running_tasks"');
    expect(runs.parameters).toEqual(
      expect.arrayContaining(['The agent stopped reporting on this task.', 600, 86_400]),
    );
    expect(restores.sql).toContain('update "restore_runs"');
    expect(retries.finalize).toHaveBeenCalledWith(RUN_A);
  });

  it('uses the configured leases and can be switched off', async () => {
    process.env.AGENT_TASK_HEARTBEAT_TIMEOUT_SECONDS = '900';
    process.env.AGENT_TASK_LEGACY_TIMEOUT_SECONDS = '7200';
    const on = make();
    await on.service.failExpiredLeases();
    expect(on.queries[0].parameters).toEqual(expect.arrayContaining([900, 7200]));

    process.env.AGENT_TASK_HEARTBEAT_TIMEOUT_SECONDS = '0';
    const off = make();
    await off.service.failExpiredLeases();
    expect(off.queries).toHaveLength(0);
  });

  it('does not count the time before the server started', async () => {
    const { service, queries } = make();
    const before = Date.now();

    await service.failExpiredLeases();

    // $7 is the server start, the floor of every heartbeat.
    const startedAt = queries[0].parameters[6] as Date;
    expect(startedAt).toBeInstanceOf(Date);
    expect(startedAt.getTime()).toBeLessThanOrEqual(before);
    expect(before - startedAt.getTime()).toBeLessThan(60_000);
  });
});

describe('RunLeaseService.failStaleQueuedRestores', () => {
  it('discards restores their agent did not pick up in time', async () => {
    const { service, queries } = make(() => [{ id: RUN_A }]);

    await service.failStaleQueuedRestores();

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('update "restore_runs" set "status" = $1, "finished_at" = $2, "error" = $3 from "agents"');
    expect(queries[0].sql).toContain('"restore_runs"."status" = $4');
    expect(queries[0].sql).toContain(
      '"restore_runs"."created_at" < $5::timestamptz - greatest($6::int, coalesce(2 * "agents"."poll_interval_seconds" + 60, 0))',
    );
    expect(queries[0].parameters).toEqual([
      'failed',
      expect.any(Date),
      'The agent did not pick up this restore in time — it was discarded so it cannot run later unexpectedly.',
      'queued',
      expect.any(Date),
      3600,
    ]);
  });

  it('can be switched off', async () => {
    process.env.RESTORE_QUEUE_TIMEOUT_SECONDS = '0';
    const { service, queries } = make();

    await service.failStaleQueuedRestores();

    expect(queries).toHaveLength(0);
  });
});
