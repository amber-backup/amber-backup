import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { chain, createDbMock } from '../testing/db-mock';
import { RunsService } from './runs.service';
import { AccessControlService } from '../common/access-control.service';
import { JobRunnerService } from '../jobs/job-runner.service';
import { PruneRunnerService } from '../jobs/prune-runner.service';
import { CheckRunnerService } from '../jobs/check-runner.service';
import { RequestUser } from '../common/auth/request-user';

const user = { id: 'u1', isAdmin: true } as RequestUser;

/** ACL stub that allows everything unless a level is explicitly denied. */
function allowAll(): AccessControlService {
  return { assert: jest.fn(async () => undefined) } as unknown as AccessControlService;
}

interface Row {
  id: string;
  job_id: string;
  status: string;
  agent_id?: string | null;
}

function setup(
  run: Row,
  runners: { job?: boolean; prune?: boolean; check?: boolean } = {},
) {
  const select = chain({ executeTakeFirst: run });
  const update = chain({ execute: [] });
  const { db } = createDbMock({ selectFrom: select, updateTable: update });
  const jobRunner = {
    cancel: jest.fn(() => runners.job ?? false),
  } as unknown as JobRunnerService;
  const pruneRunner = {
    cancel: jest.fn(() => runners.prune ?? false),
  } as unknown as PruneRunnerService;
  const checkRunner = {
    cancel: jest.fn(() => runners.check ?? false),
  } as unknown as CheckRunnerService;
  const acl = allowAll();
  const service = new RunsService(db, acl, jobRunner, pruneRunner, checkRunner);
  return { service, update, jobRunner, pruneRunner, checkRunner, acl };
}

/** A `where(sql\`false\`)` predicate: the union side is ruled out by the kind filter. */
function isFalsePredicate(call: unknown[]): boolean {
  const node = (call[0] as { toOperationNode?: () => { sqlFragments?: string[] } })
    ?.toOperationNode?.();
  return call.length === 1 && node?.sqlFragments?.join('') === 'false';
}

describe('RunsService.list (activity feed)', () => {
  function setupList(visible: string[] | 'all') {
    const jobs = chain();
    const restores = chain();
    const outer = chain({ execute: [{ id: 'r1' }] });
    const { db, selectFrom } = createDbMock({
      selectFrom: (table) =>
        table === 'job_runs' ? jobs : table === 'restore_runs' ? restores : outer,
    });
    const acl = {
      visibleResourceIds: jest.fn(async () => visible),
    } as unknown as AccessControlService;
    const service = new RunsService(
      db,
      acl,
      {} as JobRunnerService,
      {} as PruneRunnerService,
      {} as CheckRunnerService,
    );
    return { service, jobs, restores, outer, selectFrom };
  }

  it('unions job runs and restores, newest first with a stable tiebreaker', async () => {
    const { service, jobs, restores, outer } = setupList('all');

    await expect(service.list(user, { limit: 20, offset: 40 })).resolves.toEqual([{ id: 'r1' }]);

    expect(jobs.unionAll).toHaveBeenCalledWith(restores);
    expect(outer.orderBy.mock.calls).toEqual([
      ['created_at', 'desc'],
      ['id', 'desc'],
    ]);
    expect(outer.limit).toHaveBeenCalledWith(20);
    expect(outer.offset).toHaveBeenCalledWith(40);
    // Restores join their job loosely: it may have been deleted since.
    expect(restores.leftJoin).toHaveBeenCalledWith(
      'backup_jobs',
      'backup_jobs.id',
      'restore_runs.job_id',
    );
  });

  it('shows an admin every restore, including those of deleted jobs', async () => {
    const { service, restores } = setupList('all');

    await service.list(user);

    expect(restores.where).not.toHaveBeenCalled();
  });

  it('limits both kinds to the jobs a user can see', async () => {
    const { service, jobs, restores } = setupList(['j1', 'j2']);

    await service.list({ id: 'u2', isAdmin: false } as RequestUser);

    expect(jobs.where).toHaveBeenCalledWith('backup_jobs.id', 'in', ['j1', 'j2']);
    // `in` never matches a null job_id, so orphaned restores stay admin-only.
    expect(restores.where).toHaveBeenCalledWith('restore_runs.job_id', 'in', ['j1', 'j2']);
  });

  it('returns nothing without querying when no job is visible', async () => {
    const { service, selectFrom } = setupList([]);

    await expect(service.list({ id: 'u2', isAdmin: false } as RequestUser)).resolves.toEqual([]);
    expect(selectFrom).not.toHaveBeenCalled();
  });

  it('takes a comma list of kinds spanning job runs and restores', async () => {
    const { service, jobs, restores } = setupList('all');

    await service.list(user, { kind: 'backup,restore' });

    expect(jobs.where).toHaveBeenCalledWith('job_runs.kind', 'in', ['backup']);
    expect(jobs.where.mock.calls.some(isFalsePredicate)).toBe(false);
    expect(restores.where.mock.calls.some(isFalsePredicate)).toBe(false);
  });

  it('rules out job runs when only restores are asked for', async () => {
    const { service, jobs, restores } = setupList('all');

    await service.list(user, { kind: 'restore' });

    expect(jobs.where.mock.calls.some(isFalsePredicate)).toBe(true);
    expect(jobs.where).not.toHaveBeenCalledWith('job_runs.kind', 'in', expect.anything());
    expect(restores.where.mock.calls.some(isFalsePredicate)).toBe(false);
  });

  it('rules out restores when only job-run kinds are asked for', async () => {
    const { service, jobs, restores } = setupList('all');

    await service.list(user, { kind: 'prune,check' });

    expect(jobs.where).toHaveBeenCalledWith('job_runs.kind', 'in', ['prune', 'check']);
    expect(restores.where.mock.calls.some(isFalsePredicate)).toBe(true);
  });

  it('applies the job and status filters to both kinds', async () => {
    const { service, jobs, restores } = setupList('all');

    await service.list(user, { jobId: 'j1', status: 'running' });

    expect(jobs.where).toHaveBeenCalledWith('job_runs.job_id', '=', 'j1');
    expect(jobs.where).toHaveBeenCalledWith('job_runs.status', '=', 'running');
    expect(restores.where).toHaveBeenCalledWith('restore_runs.job_id', '=', 'j1');
    expect(restores.where).toHaveBeenCalledWith('restore_runs.status', '=', 'running');
  });

  it('matches the search term against the job name of both kinds, wildcards literal', async () => {
    const { service, jobs, restores } = setupList('all');

    await service.list(user, { search: '50%_off' });

    expect(jobs.where).toHaveBeenCalledWith('backup_jobs.name', 'ilike', '%50\\%\\_off%');
    expect(restores.where).toHaveBeenCalledWith('backup_jobs.name', 'ilike', '%50\\%\\_off%');
  });
});

describe('RunsService.cancel', () => {
  it('aborts a locally running backup through the job runner without touching the row', async () => {
    const { service, update, jobRunner } = setup(
      { id: 'r1', job_id: 'j1', status: 'running' },
      { job: true },
    );

    await expect(service.cancel(user, 'r1')).resolves.toEqual({ cancelled: true });

    expect(jobRunner.cancel).toHaveBeenCalledWith('r1');
    // The runner writes the final status itself, so cancel must not race it.
    expect(update.set).not.toHaveBeenCalled();
  });

  it('aborts a locally running prune through the prune runner', async () => {
    const { service, update, pruneRunner } = setup(
      { id: 'r2', job_id: 'j1', status: 'running' },
      { prune: true },
    );

    await service.cancel(user, 'r2');

    expect(pruneRunner.cancel).toHaveBeenCalledWith('r2');
    expect(update.set).not.toHaveBeenCalled();
  });

  it('marks a queued run cancelled when no process is running yet', async () => {
    const { service, update } = setup({ id: 'r3', job_id: 'j1', status: 'queued' });

    await service.cancel(user, 'r3');

    const patch = update.set.mock.calls[0][0] as { status: string; finished_at: Date };
    expect(patch.status).toBe('cancelled');
    expect(patch.finished_at).toBeInstanceOf(Date);
  });

  it('force-cancels a hung run whose process is gone', async () => {
    const { service, update } = setup({ id: 'r4', job_id: 'j1', status: 'running' });

    await service.cancel(user, 'r4');

    const patch = update.set.mock.calls[0][0] as { status: string; error: string };
    expect(patch.status).toBe('cancelled');
    expect(patch.error).toMatch(/no running process/i);
  });

  it('warns that an agent may still be working when cancelling a remote run', async () => {
    const { service, update } = setup({
      id: 'r5',
      job_id: 'j1',
      status: 'running',
      agent_id: 'a1',
    });

    await service.cancel(user, 'r5');

    const patch = update.set.mock.calls[0][0] as { status: string; error: string };
    expect(patch.status).toBe('cancelled');
    expect(patch.error).toMatch(/agent may still be running/i);
  });

  it('rejects cancelling a run that already finished', async () => {
    const { service, update } = setup({ id: 'r6', job_id: 'j1', status: 'success' });

    await expect(service.cancel(user, 'r6')).rejects.toBeInstanceOf(BadRequestException);
    expect(update.set).not.toHaveBeenCalled();
  });

  it('refuses a user without operate access', async () => {
    const { service, acl, update } = setup({ id: 'r7', job_id: 'j1', status: 'running' });
    (acl.assert as jest.Mock).mockImplementation(async (_u, _t, _id, level: string) => {
      if (level === 'operate') throw new ForbiddenException('nope');
    });

    await expect(service.cancel(user, 'r7')).rejects.toBeInstanceOf(ForbiddenException);
    expect(update.set).not.toHaveBeenCalled();
  });
});
