import { ConflictException } from '@nestjs/common';
import { chain, createDbMock } from '../testing/db-mock';
import {
  CheckRunnerService,
  DAMAGED_MESSAGE,
  planCheck,
  repositoryPatch,
  versionLess,
} from './check-runner.service';
import { ResticService, checkArgs, isDamagedCheckOutput } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JobsService } from './jobs.service';
import { BackupJobRow } from '../database/database.types';

/** Lets the fire-and-forget local execution settle. */
const flush = () => new Promise((r) => setImmediate(r));

describe('CheckRunnerService', () => {
  const baseJob = {
    id: 'j1',
    location: 'local',
    repository_id: 'repo-1',
    integrity_check: {},
    repo_check_subset_next: 1,
    repo_check_subset_parts: null,
  } as unknown as BackupJobRow;

  function make(
    opts: {
      job?: Partial<BackupJobRow>;
      activeRun?: unknown;
      activeRestore?: unknown;
      agent?: unknown;
      check?: jest.Mock;
      updated?: number;
    } = {},
  ) {
    const insert = chain({ executeTakeFirstOrThrow: { id: 'c1' } });
    const runsSelect = chain({ executeTakeFirst: opts.activeRun });
    const restoresSelect = chain({ executeTakeFirst: opts.activeRestore });
    const agentsSelect = chain({ executeTakeFirst: opts.agent });
    const runUpdate = chain({
      executeTakeFirst: { numUpdatedRows: BigInt(opts.updated ?? 1) },
    });
    const repoUpdate = chain({ execute: [] });
    const { db } = createDbMock({
      insertInto: insert,
      selectFrom: (t) =>
        t === 'restore_runs' ? restoresSelect : t === 'agents' ? agentsSelect : runsSelect,
      updateTable: (t) => (t === 'repositories' ? repoUpdate : runUpdate),
    });
    const restic = {
      check: opts.check ?? jest.fn().mockResolvedValue({ damaged: false }),
    };
    const targets = { resolveForJob: jest.fn().mockResolvedValue({ repository: 'r' }) };
    const notifications = { notifyJobRun: jest.fn().mockResolvedValue(undefined) };
    const jobs = { getRow: jest.fn().mockResolvedValue({ ...baseJob, ...opts.job }) };
    const service = new CheckRunnerService(
      db,
      restic as unknown as ResticService,
      targets as unknown as TargetsService,
      notifications as unknown as NotificationsService,
      jobs as unknown as JobsService,
    );
    return { service, insert, runUpdate, repoUpdate, restic, notifications, runsSelect };
  }

  describe('start', () => {
    it('runs a local check, records it as passed and notifies', async () => {
      const { service, insert, runUpdate, repoUpdate, restic, notifications } = make();

      await expect(service.start('j1', 'manual', 'quick')).resolves.toBe('c1');
      await flush();

      expect(insert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          job_id: 'j1',
          kind: 'check',
          trigger: 'manual',
          status: 'running',
          check_info: JSON.stringify({ level: 'quick' }),
        }),
      );
      expect(restic.check).toHaveBeenCalledWith(
        { repository: 'r' },
        { level: 'quick' },
        expect.anything(),
      );
      expect(runUpdate.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success', error: null }),
      );
      expect(repoUpdate.set).toHaveBeenCalledWith(
        expect.objectContaining({ check_status: 'passed', check_level: 'quick' }),
      );
      expect(notifications.notifyJobRun).toHaveBeenCalledWith('c1');
    });

    it('marks a damaged repository and fails the run', async () => {
      const { service, runUpdate, repoUpdate } = make({
        check: jest.fn().mockResolvedValue({ damaged: true }),
      });

      await service.start('j1', 'schedule', 'full');
      await flush();

      expect(runUpdate.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          error: DAMAGED_MESSAGE,
          check_info: JSON.stringify({ level: 'full', damaged: true }),
        }),
      );
      expect(repoUpdate.set).toHaveBeenCalledWith(
        expect.objectContaining({ check_status: 'damaged' }),
      );
    });

    it('keeps the verdict when the check cannot run, recording only the error', async () => {
      const { service, runUpdate, repoUpdate } = make({
        check: jest.fn().mockRejectedValue(new Error('repository is already locked')),
      });

      await service.start('j1', 'manual', 'quick');
      await flush();

      expect(runUpdate.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed', error: 'repository is already locked' }),
      );
      expect(repoUpdate.set).toHaveBeenCalledWith({
        check_error: 'repository is already locked',
      });
    });

    it('leaves agent checks queued for the agent', async () => {
      const { service, insert, restic } = make({ job: { location: 'agent' } });

      await service.start('j1', 'manual', 'quick');
      await flush();

      expect(insert.values).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'queued', started_at: null }),
      );
      expect(restic.check).not.toHaveBeenCalled();
    });

    it('refuses an agent check when the agent is too old to run it', async () => {
      const { service, insert } = make({
        job: { location: 'agent', agent_id: 'a1' },
        agent: { name: 'RABE', agent_version: '1.25.1' },
      });

      await expect(service.start('j1', 'manual', 'quick')).rejects.toThrow(
        /RABE runs version 1\.25\.1/,
      );
      expect(insert.values).not.toHaveBeenCalled();
    });

    it('queues an agent check for an agent that supports it', async () => {
      const { service, insert } = make({
        job: { location: 'agent', agent_id: 'a1' },
        agent: { name: 'AKITA', agent_version: '1.30.0' },
      });

      await service.start('j1', 'manual', 'quick');

      expect(insert.values).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'queued' }),
      );
    });

    it('refuses while another activity uses the repository', async () => {
      const { service, insert } = make({ activeRun: { kind: 'backup', status: 'running' } });

      await expect(service.start('j1', 'manual', 'quick')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(insert.values).not.toHaveBeenCalled();
    });

    it('refuses while a restore reads the repository', async () => {
      const { service } = make({ activeRestore: { id: 'rs1' } });

      await expect(service.start('j1', 'manual', 'quick')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('recordAgentResult', () => {
    it('changes nothing else when the run was cancelled meanwhile', async () => {
      const { service, runsSelect, repoUpdate, notifications } = make({ updated: 0 });
      runsSelect.executeTakeFirst.mockResolvedValue({
        check_info: { level: 'quick' },
        repository_id: 'repo-1',
      });

      await service.recordAgentResult('agent-1', 'c1', { status: 'success', damaged: false });

      expect(repoUpdate.set).not.toHaveBeenCalled();
      expect(notifications.notifyJobRun).not.toHaveBeenCalled();
    });
  });

  it('aborts a running local check on cancel', async () => {
    let signal: AbortSignal | undefined;
    const check = jest.fn(
      (_ctx, _info, hooks: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal = hooks.signal;
          hooks.signal.addEventListener('abort', () => reject(new Error('killed')));
        }),
    );
    const { service, runUpdate, repoUpdate } = make({ check });

    await service.start('j1', 'manual', 'quick');
    await flush();
    expect(service.cancel('c1')).toBe(true);
    await flush();

    expect(signal?.aborted).toBe(true);
    expect(runUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
    expect(repoUpdate.set).not.toHaveBeenCalled();
    expect(service.cancel('c1')).toBe(false);
  });
});

describe('planCheck', () => {
  const job = (over: Partial<BackupJobRow>) =>
    ({
      integrity_check: {},
      repo_check_subset_next: 1,
      repo_check_subset_parts: null,
      ...over,
    }) as BackupJobRow;

  it("defaults to the schedule's level, else quick", () => {
    expect(planCheck(job({}))).toEqual({ level: 'quick' });
    expect(planCheck(job({ integrity_check: { level: 'full' } }))).toEqual({ level: 'full' });
    expect(planCheck(job({ integrity_check: { level: 'full' } }), 'quick')).toEqual({
      level: 'quick',
    });
  });

  it('continues a rotation where it left off', () => {
    expect(
      planCheck(
        job({
          integrity_check: { subsetParts: 12 },
          repo_check_subset_next: 5,
          repo_check_subset_parts: 12,
        }),
        'rotating',
      ),
    ).toEqual({ level: 'rotating', part: 5, parts: 12 });
  });

  it('restarts the rotation when the number of parts changed', () => {
    expect(
      planCheck(
        job({
          integrity_check: { subsetParts: 4 },
          repo_check_subset_next: 9,
          repo_check_subset_parts: 12,
        }),
        'rotating',
      ),
    ).toEqual({ level: 'rotating', part: 1, parts: 4 });
  });
});

describe('versionLess', () => {
  it('compares numerically per component', () => {
    expect(versionLess('1.25.1', '1.26.0')).toBe(true);
    expect(versionLess('1.26.0', '1.26.0')).toBe(false);
    expect(versionLess('1.100.0', '1.26.0')).toBe(false);
    expect(versionLess('v2.0.0', '1.26.0')).toBe(false);
  });
});

describe('repositoryPatch', () => {
  const passed = { status: 'success' as const, damaged: false };

  it('advances a passed rotation and marks all data verified after the last part', () => {
    const mid = repositoryPatch({ level: 'rotating', part: 3, parts: 12 }, passed);
    expect(mid).toEqual(expect.objectContaining({ check_subset_next: 4, check_subset_parts: 12 }));
    expect(mid.data_verified_at).toBeUndefined();

    const last = repositoryPatch({ level: 'rotating', part: 12, parts: 12 }, passed);
    expect(last).toEqual(expect.objectContaining({ check_subset_next: 1 }));
    expect(last.data_verified_at).toBeInstanceOf(Date);
  });

  it('does not advance the rotation when damage was found', () => {
    const patch = repositoryPatch(
      { level: 'rotating', part: 3, parts: 12 },
      { status: 'failed', damaged: true },
    );
    expect(patch.check_status).toBe('damaged');
    expect(patch.check_subset_next).toBeUndefined();
  });

  it('marks all data verified after a full check', () => {
    expect(repositoryPatch({ level: 'full' }, passed).data_verified_at).toBeInstanceOf(Date);
  });
});

describe('restic check helpers', () => {
  it('maps levels to restic arguments', () => {
    expect(checkArgs({ level: 'quick' })).toEqual(['check']);
    expect(checkArgs({ level: 'full' })).toEqual(['check', '--read-data']);
    expect(checkArgs({ level: 'rotating', part: 2, parts: 12 })).toEqual([
      'check',
      '--read-data-subset=2/12',
    ]);
  });

  it('tells damage apart from a check that could not run', () => {
    expect(isDamagedCheckOutput('Fatal: repository contains errors')).toBe(true);
    expect(isDamagedCheckOutput('Fatal: unable to create lock in backend')).toBe(false);
  });
});
