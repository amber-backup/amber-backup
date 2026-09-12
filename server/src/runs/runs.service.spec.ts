import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { chain, createDbMock } from '../testing/db-mock';
import { RunsService } from './runs.service';
import { AccessControlService } from '../common/access-control.service';
import { JobRunnerService } from '../jobs/job-runner.service';
import { PruneRunnerService } from '../jobs/prune-runner.service';
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

function setup(run: Row, runners: { job?: boolean; prune?: boolean } = {}) {
  const select = chain({ executeTakeFirst: run });
  const update = chain({ execute: [] });
  const { db } = createDbMock({ selectFrom: select, updateTable: update });
  const jobRunner = {
    cancel: jest.fn(() => runners.job ?? false),
  } as unknown as JobRunnerService;
  const pruneRunner = {
    cancel: jest.fn(() => runners.prune ?? false),
  } as unknown as PruneRunnerService;
  const acl = allowAll();
  const service = new RunsService(db, acl, jobRunner, pruneRunner);
  return { service, update, jobRunner, pruneRunner, acl };
}

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
