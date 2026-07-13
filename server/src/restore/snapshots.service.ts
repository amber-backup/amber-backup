import { Injectable } from '@nestjs/common';
import { RequestUser } from '../common/auth/request-user';
import { AccessControlService } from '../common/access-control.service';
import { ResticService } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';
import { JobsService } from '../jobs/jobs.service';

/**
 * Live snapshot browsing (§10.1). Snapshots are read from the repository on
 * demand (never persisted). A repository is defined by a backup job (its
 * connection + repo config + password), so access is gated on the job.
 */
@Injectable()
export class SnapshotsService {
  constructor(
    private readonly acl: AccessControlService,
    private readonly restic: ResticService,
    private readonly targets: TargetsService,
    private readonly jobs: JobsService,
  ) {}

  async list(
    user: RequestUser,
    jobId: string,
    filters: { host?: string; tags?: string[]; path?: string },
  ) {
    await this.acl.assert(user, 'job', jobId, 'view');
    const ctx = await this.targets.resolveForJob(await this.jobs.getRow(jobId));
    const snaps = await this.restic.snapshots(ctx, {
      host: filters.host,
      tags: filters.tags,
      paths: filters.path ? [filters.path] : undefined,
    });
    // Newest first (restic returns them oldest-first). `time` is ISO-8601, so
    // a lexicographic compare is chronological.
    snaps.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
    return snaps;
  }

  /** Permanently deletes a snapshot (requires 'manage' — this destroys data). */
  async remove(
    user: RequestUser,
    jobId: string,
    snapshotId: string,
    prune = false,
  ) {
    await this.acl.assert(user, 'job', jobId, 'manage');
    const ctx = await this.targets.resolveForJob(await this.jobs.getRow(jobId));
    return this.restic.forgetSnapshots(ctx, [snapshotId], prune);
  }

  async ls(user: RequestUser, jobId: string, snapshotId: string, path?: string) {
    await this.acl.assert(user, 'job', jobId, 'view');
    const ctx = await this.targets.resolveForJob(await this.jobs.getRow(jobId));
    const entries = await this.restic.ls(ctx, snapshotId, path);
    // Sort directories first, then by name.
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    return entries;
  }
}
