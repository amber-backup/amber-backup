import { chain, createDbMock } from '../testing/db-mock';
import { JobRunnerService } from './job-runner.service';
import { ResticService } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';
import { RunRetryService } from './run-retry.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { PruneRunnerService } from './prune-runner.service';

describe('JobRunnerService', () => {
  function make(staleIds: string[]) {
    const update = chain({ execute: staleIds.map((id) => ({ id })) });
    const { db } = createDbMock({ updateTable: update });
    const retries = { finalize: jest.fn().mockResolvedValue(undefined) };
    const service = new JobRunnerService(
      db,
      {} as ResticService,
      {} as TargetsService,
      retries as unknown as RunRetryService,
      {} as RepositoriesService,
      {} as PruneRunnerService,
    );
    return { service, update, retries, db };
  }

  afterEach(() => {
    delete process.env.RUN_QUEUE_TIMEOUT_SECONDS;
  });

  describe('failStaleQueuedRuns', () => {
    it('fails queued backups and checks older than the timeout and settles each', async () => {
      process.env.RUN_QUEUE_TIMEOUT_SECONDS = '300';
      const { service, update, retries } = make(['r1', 'r2']);

      await service.failStaleQueuedRuns();

      expect(update.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          finished_at: expect.any(Date),
          error: expect.stringContaining('5 min'),
        }),
      );
      expect(update.where).toHaveBeenCalledWith('kind', '=', 'backup');
      expect(update.where).toHaveBeenCalledWith('kind', '=', 'check');
      expect(update.set).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('too old for integrity checks') }),
      );
      expect(update.where).toHaveBeenCalledWith('status', '=', 'queued');
      // A pending retry counts from when it became due, not from when it was queued.
      const cutoffCall = update.where.mock.calls.find((c) => c[1] === '<')!;
      const cutoffSql = cutoffCall[0] as { toOperationNode(): { sqlFragments: string[] } };
      expect(cutoffSql.toOperationNode().sqlFragments.join('')).toBe(
        'coalesce(not_before, created_at)',
      );
      const cutoff = cutoffCall[2] as Date;
      expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(300_000);
      // The stub returns the same rows for both kinds.
      expect(retries.finalize).toHaveBeenCalledTimes(4);
      expect(retries.finalize).toHaveBeenCalledWith('r1');
      expect(retries.finalize).toHaveBeenCalledWith('r2');
    });

    it('does nothing when the timeout is disabled', async () => {
      process.env.RUN_QUEUE_TIMEOUT_SECONDS = '0';
      const { service, update, retries } = make(['r1']);

      await service.failStaleQueuedRuns();

      expect(update.execute).not.toHaveBeenCalled();
      expect(retries.finalize).not.toHaveBeenCalled();
    });
  });

  describe('startDueRetries', () => {
    it('claims due local retries by clearing not_before and dispatches each', async () => {
      const { service, update } = make(['r1', 'r2']);
      const dispatch = jest.spyOn(service, 'dispatch').mockResolvedValue(undefined);

      await service.startDueRetries();

      expect(update.set).toHaveBeenCalledWith({ not_before: null });
      expect(update.where).toHaveBeenCalledWith('status', '=', 'queued');
      expect(update.where).toHaveBeenCalledWith('not_before', '<=', expect.any(Date));
      expect(dispatch).toHaveBeenCalledWith('r1');
      expect(dispatch).toHaveBeenCalledWith('r2');
    });
  });
});
