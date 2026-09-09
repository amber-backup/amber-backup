import { chain, createDbMock } from '../testing/db-mock';
import { JobRunnerService } from './job-runner.service';
import { ResticService } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { PruneRunnerService } from './prune-runner.service';

describe('JobRunnerService', () => {
  function make(staleIds: string[]) {
    const update = chain({ execute: staleIds.map((id) => ({ id })) });
    const { db } = createDbMock({ updateTable: update });
    const notifications = { notifyJobRun: jest.fn().mockResolvedValue(undefined) };
    const service = new JobRunnerService(
      db,
      {} as ResticService,
      {} as TargetsService,
      notifications as unknown as NotificationsService,
      {} as RepositoriesService,
      {} as PruneRunnerService,
    );
    return { service, update, notifications };
  }

  afterEach(() => {
    delete process.env.RUN_QUEUE_TIMEOUT_SECONDS;
  });

  describe('failStaleQueuedRuns', () => {
    it('fails queued backups older than the timeout and notifies for each', async () => {
      process.env.RUN_QUEUE_TIMEOUT_SECONDS = '300';
      const { service, update, notifications } = make(['r1', 'r2']);

      await service.failStaleQueuedRuns();

      expect(update.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          finished_at: expect.any(Date),
          error: expect.stringContaining('5 min'),
        }),
      );
      expect(update.where).toHaveBeenCalledWith('kind', '=', 'backup');
      expect(update.where).toHaveBeenCalledWith('status', '=', 'queued');
      const cutoff = update.where.mock.calls.find((c) => c[0] === 'created_at')![2] as Date;
      expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(300_000);
      expect(notifications.notifyJobRun).toHaveBeenCalledTimes(2);
      expect(notifications.notifyJobRun).toHaveBeenCalledWith('r1');
      expect(notifications.notifyJobRun).toHaveBeenCalledWith('r2');
    });

    it('does nothing when the timeout is disabled', async () => {
      process.env.RUN_QUEUE_TIMEOUT_SECONDS = '0';
      const { service, update, notifications } = make(['r1']);

      await service.failStaleQueuedRuns();

      expect(update.execute).not.toHaveBeenCalled();
      expect(notifications.notifyJobRun).not.toHaveBeenCalled();
    });
  });
});
