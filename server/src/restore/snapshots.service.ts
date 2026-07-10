import { Injectable } from '@nestjs/common';
import { RequestUser } from '../common/auth/request-user';
import { AccessControlService } from '../common/access-control.service';
import { ResticService } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';

/**
 * Live snapshot browsing (§10.1). Snapshots are read from the repository on
 * demand (never persisted). Requires 'view' on the target.
 */
@Injectable()
export class SnapshotsService {
  constructor(
    private readonly acl: AccessControlService,
    private readonly restic: ResticService,
    private readonly targets: TargetsService,
  ) {}

  async list(
    user: RequestUser,
    targetId: string,
    filters: { host?: string; tags?: string[]; path?: string },
  ) {
    await this.acl.assert(user, 'target', targetId, 'view');
    const ctx = await this.targets.resolve(targetId);
    return this.restic.snapshots(ctx, {
      host: filters.host,
      tags: filters.tags,
      paths: filters.path ? [filters.path] : undefined,
    });
  }

  async ls(
    user: RequestUser,
    targetId: string,
    snapshotId: string,
    path?: string,
  ) {
    await this.acl.assert(user, 'target', targetId, 'view');
    const ctx = await this.targets.resolve(targetId);
    const entries = await this.restic.ls(ctx, snapshotId, path);
    // Sort directories first, then by name.
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    return entries;
  }
}
