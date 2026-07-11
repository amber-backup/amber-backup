import { SnapshotsService } from './snapshots.service';
import { AccessControlService } from '../common/access-control.service';
import { ResticService } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';
import { RequestUser } from '../common/auth/request-user';

describe('SnapshotsService', () => {
  const user = { id: 'u1' } as RequestUser;
  const ctx = { repository: 'repo' } as never;

  function make(snapshots: Array<{ id: string; time: string }> = []) {
    const acl = { assert: jest.fn().mockResolvedValue(undefined) };
    const restic = {
      snapshots: jest.fn().mockResolvedValue(snapshots),
      forgetSnapshots: jest.fn().mockResolvedValue({ removed: 1, raw: [] }),
    };
    const targets = { resolve: jest.fn().mockResolvedValue(ctx) };
    const service = new SnapshotsService(
      acl as unknown as AccessControlService,
      restic as unknown as ResticService,
      targets as unknown as TargetsService,
    );
    return { service, acl, restic, targets };
  }

  describe('list', () => {
    it('returns snapshots newest-first and only needs view', async () => {
      const { service, acl } = make([
        { id: 'a', time: '2026-01-01T10:00:00Z' },
        { id: 'c', time: '2026-03-01T10:00:00Z' },
        { id: 'b', time: '2026-02-01T10:00:00Z' },
      ]);

      const out = await service.list(user, 't1', {});

      expect(out.map((s) => s.id)).toEqual(['c', 'b', 'a']);
      expect(acl.assert).toHaveBeenCalledWith(user, 'target', 't1', 'view');
    });
  });

  describe('remove', () => {
    it('requires manage and forgets the snapshot (no prune by default)', async () => {
      const { service, acl, restic } = make();

      await service.remove(user, 't1', 'snap-1');

      expect(acl.assert).toHaveBeenCalledWith(user, 'target', 't1', 'manage');
      expect(restic.forgetSnapshots).toHaveBeenCalledWith(ctx, ['snap-1'], false);
    });

    it('forwards the prune flag', async () => {
      const { service, restic } = make();

      await service.remove(user, 't1', 'snap-1', true);

      expect(restic.forgetSnapshots).toHaveBeenCalledWith(ctx, ['snap-1'], true);
    });
  });
});
