import { chain, createDbMock } from '../testing/db-mock';
import { RunRetryService } from './run-retry.service';
import { NotificationsService } from '../notifications/notifications.service';

describe('RunRetryService', () => {
  const failedRun = {
    job_id: 'job-1',
    kind: 'backup',
    status: 'failed',
    trigger: 'schedule',
    attempt: 1,
    retry_max: 2,
    retry_delay_seconds: 60,
  };

  function make(run: unknown, active?: unknown) {
    const runSelect = chain({ executeTakeFirst: run });
    const activeSelect = chain({ executeTakeFirst: active });
    let selects = 0;
    const insert = chain({ executeTakeFirstOrThrow: { id: 'retry-1' } });
    const { db } = createDbMock({
      // First read: the finished run; second: other active backups of the job.
      selectFrom: () => (selects++ === 0 ? runSelect : activeSelect),
      insertInto: insert,
    });
    const notifications = { notifyJobRun: jest.fn().mockResolvedValue(undefined) };
    const service = new RunRetryService(db, notifications as unknown as NotificationsService);
    return { service, insert, notifications };
  }

  it('queues the next attempt after the delay and does not notify', async () => {
    const { service, insert, notifications } = make(failedRun);
    const before = Date.now();

    await service.finalize('run-1');

    const values = insert.values.mock.calls[0][0];
    expect(values).toMatchObject({
      job_id: 'job-1',
      kind: 'backup',
      trigger: 'schedule',
      status: 'queued',
      attempt: 2,
      retry_of_run_id: 'run-1',
    });
    expect(values.not_before.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(notifications.notifyJobRun).not.toHaveBeenCalled();
  });

  it('notifies instead once the retries are used up', async () => {
    const { service, insert, notifications } = make({ ...failedRun, attempt: 3 });

    await service.finalize('run-1');

    expect(insert.values).not.toHaveBeenCalled();
    expect(notifications.notifyJobRun).toHaveBeenCalledWith('run-1');
  });

  it.each([
    ['retries are off', { retry_max: 0 }],
    ['the run was cancelled', { status: 'cancelled' }],
    ['the run succeeded', { status: 'success' }],
    ['the run is a check', { kind: 'check' }],
  ])('does not retry when %s', async (_, patch) => {
    const { service, insert, notifications } = make({ ...failedRun, ...patch });

    await service.finalize('run-1');

    expect(insert.values).not.toHaveBeenCalled();
    expect(notifications.notifyJobRun).toHaveBeenCalledWith('run-1');
  });

  it('does not retry while another backup of the job is queued or running', async () => {
    const { service, insert } = make(failedRun, { id: 'run-2' });

    expect(await service.scheduleRetry('run-1')).toBeNull();
    expect(insert.values).not.toHaveBeenCalled();
  });

  it('still notifies when queueing the retry fails', async () => {
    const { service, insert, notifications } = make(failedRun);
    insert.executeTakeFirstOrThrow.mockRejectedValueOnce(new Error('db down'));

    await service.finalize('run-1');

    expect(notifications.notifyJobRun).toHaveBeenCalledWith('run-1');
  });
});
