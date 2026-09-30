import { BadRequestException, NotFoundException } from '@nestjs/common';
import { chain, createDbMock } from '../testing/db-mock';
import { RestoreService } from './restore.service';
import { AccessControlService } from '../common/access-control.service';
import { RequestUser } from '../common/auth/request-user';
import { JobsService } from '../jobs/jobs.service';
import { RestoreRunnerService } from './restore-runner.service';

const admin = { id: 'u1', isAdmin: true } as RequestUser;

interface Row {
  id: string;
  job_id: string | null;
  status: string;
  agent_id?: string | null;
}

function setup(run: Row, opts: { local?: boolean } = {}) {
  const update = chain({ execute: [] });
  const { db } = createDbMock({
    selectFrom: chain({ executeTakeFirst: run }),
    updateTable: update,
  });
  const acl = { assert: jest.fn(async () => undefined) } as unknown as AccessControlService;
  const runner = {
    cancel: jest.fn(() => opts.local ?? false),
  } as unknown as RestoreRunnerService;
  const service = new RestoreService(db, acl, {} as JobsService, runner);
  return { service, update, runner, acl };
}

describe('RestoreService.cancel', () => {
  it('aborts a local restore through the runner without touching the row', async () => {
    const { service, update, runner } = setup(
      { id: 'rs1', job_id: 'j1', status: 'running' },
      { local: true },
    );

    await expect(service.cancel(admin, 'rs1')).resolves.toEqual({ cancelled: true });

    expect(runner.cancel).toHaveBeenCalledWith('rs1');
    // The runner writes the final status itself.
    expect(update.set).not.toHaveBeenCalled();
  });

  it('marks a queued restore cancelled', async () => {
    const { service, update } = setup({ id: 'rs2', job_id: 'j1', status: 'queued' });

    await service.cancel(admin, 'rs2');

    const patch = update.set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe('cancelled');
    expect(patch.error).toBeNull();
    expect(patch.finished_at).toBeInstanceOf(Date);
    expect(update.where).toHaveBeenCalledWith('status', 'in', ['queued', 'running']);
  });

  it('cancels a restore running on an agent, which may still be at work', async () => {
    const { service, update } = setup({
      id: 'rs3',
      job_id: 'j1',
      status: 'running',
      agent_id: 'a1',
    });

    await service.cancel(admin, 'rs3');

    const patch = update.set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe('cancelled');
    expect(patch.error).toBe(
      'Cancelled on the server — the agent may still be running this task.',
    );
  });

  it('force-cancels a hung local restore whose process is gone', async () => {
    const { service, update } = setup({ id: 'rs4', job_id: 'j1', status: 'running' });

    await service.cancel(admin, 'rs4');

    const patch = update.set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.error).toMatch(/no running process/i);
  });

  it('rejects cancelling a finished restore', async () => {
    const { service, update } = setup({ id: 'rs5', job_id: 'j1', status: 'success' });

    await expect(service.cancel(admin, 'rs5')).rejects.toBeInstanceOf(BadRequestException);
    expect(update.set).not.toHaveBeenCalled();
  });

  it('hides a restore of a deleted job from non-admins', async () => {
    const { service } = setup({ id: 'rs6', job_id: null, status: 'running' });

    await expect(
      service.cancel({ id: 'u2', isAdmin: false } as RequestUser, 'rs6'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
