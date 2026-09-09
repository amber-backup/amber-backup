import { chain, createDbMock } from '../testing/db-mock';
import { PruneRunnerService } from './prune-runner.service';
import { ResticService } from '../restic/restic.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { ResticContext } from '../restic/restic.types';

describe('PruneRunnerService', () => {
  const ctx = { repository: 'repo' } as ResticContext;
  const base = { jobId: 'j1', repositoryId: 'r1', trigger: 'schedule' as const, ctx };

  function make(prune: jest.Mock = jest.fn().mockResolvedValue(undefined)) {
    const insert = chain({ executeTakeFirstOrThrow: { id: 'p1' } });
    const update = chain({ execute: [] });
    const { db } = createDbMock({ insertInto: insert, updateTable: update });
    const restic = { prune };
    const repositories = { refreshStatsInBackground: jest.fn() };
    const service = new PruneRunnerService(
      db,
      restic as unknown as ResticService,
      repositories as unknown as RepositoriesService,
    );
    return { service, insert, update, restic, repositories };
  }

  describe('run', () => {
    it('records a running prune row linked to its backup, then marks it successful', async () => {
      const { service, insert, update, restic, repositories } = make();

      const id = await service.run({ ...base, parentRunId: 'b1' });

      expect(id).toBe('p1');
      expect(insert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          job_id: 'j1',
          kind: 'prune',
          parent_run_id: 'b1',
          trigger: 'schedule',
          status: 'running',
          started_at: expect.any(Date),
        }),
      );
      expect(restic.prune).toHaveBeenCalledWith(ctx, expect.anything());
      expect(update.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success', finished_at: expect.any(Date) }),
      );
      expect(update.where).toHaveBeenCalledWith('id', '=', 'p1');
      expect(repositories.refreshStatsInBackground).toHaveBeenCalledWith('r1');
    });

    it('marks the row failed with the error instead of throwing', async () => {
      const { service, update, repositories } = make(
        jest.fn().mockRejectedValue(new Error('repository is locked')),
      );

      await expect(service.run(base)).resolves.toBe('p1');

      expect(update.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed', error: 'repository is locked' }),
      );
      expect(repositories.refreshStatsInBackground).not.toHaveBeenCalled();
    });

    it('keeps the streamed restic output as the run log', async () => {
      const prune = jest.fn(async (_ctx: ResticContext, hooks: { onLog?: (l: string) => void }) => {
        hooks.onLog?.('loading indexes...');
        hooks.onLog?.('removed 3 packs');
      });
      const { service, update } = make(prune);

      await service.run(base);

      expect(update.set).toHaveBeenCalledWith(
        expect.objectContaining({ log: 'loading indexes...\nremoved 3 packs' }),
      );
    });
  });

  describe('record', () => {
    it('stores an agent-side prune as a finished activity and refreshes the repository', async () => {
      const { service, insert, repositories } = make();
      const startedAt = new Date('2026-09-09T10:00:00Z');
      const finishedAt = new Date('2026-09-09T10:04:00Z');

      const id = await service.record({
        ...base,
        parentRunId: 'b1',
        agentId: 'a1',
        status: 'success',
        startedAt,
        finishedAt,
        log: 'done',
      });

      expect(id).toBe('p1');
      expect(insert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'prune',
          parent_run_id: 'b1',
          agent_id: 'a1',
          status: 'success',
          started_at: startedAt,
          finished_at: finishedAt,
          log: 'done',
        }),
      );
      expect(repositories.refreshStatsInBackground).toHaveBeenCalledWith('r1');
    });

    it('does not refresh the repository for a failed prune', async () => {
      const { service, repositories } = make();

      await service.record({
        ...base,
        parentRunId: null,
        agentId: 'a1',
        status: 'failed',
        startedAt: new Date(),
        finishedAt: new Date(),
        error: 'boom',
      });

      expect(repositories.refreshStatsInBackground).not.toHaveBeenCalled();
    });
  });
});
