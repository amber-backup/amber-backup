import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { promises as fs } from 'fs';
import { Db, KYSELY } from '../database/database.module';
import { AccessControlService } from '../common/access-control.service';
import { RequestUser } from '../common/auth/request-user';
import { RestoreDestination } from '../database/database.types';
import { JobsService } from '../jobs/jobs.service';
import { RestoreRunnerService } from './restore-runner.service';
import { CreateRestoreDto } from './dto/restore.dto';

@Injectable()
export class RestoreService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly acl: AccessControlService,
    private readonly jobs: JobsService,
    private readonly runner: RestoreRunnerService,
  ) {}

  async create(user: RequestUser, dto: CreateRestoreDto) {
    // Restore is an 'operate' action on the job whose repository we read (§10.6).
    await this.acl.assert(user, 'job', dto.jobId, 'operate');

    // Restoring onto an agent host reaches into agent territory → admin-only.
    if (dto.destination?.agentId && !user.isAdmin) {
      throw new ForbiddenException(
        'Restoring onto an agent host requires administrator access',
      );
    }

    // Snapshot the job's repository resolution so the restore stays valid even
    // if the job is later edited or deleted.
    const job = await this.jobs.getRow(dto.jobId);

    const run = await this.db
      .insertInto('restore_runs')
      .values({
        target_id: job.target_id,
        job_id: job.id,
        repo_config:
          typeof job.repo_config === 'string'
            ? job.repo_config
            : JSON.stringify(job.repo_config),
        repo_password_secret_id: job.repo_password_secret_id,
        snapshot_id: dto.snapshotId,
        included_paths: dto.includedPaths
          ? JSON.stringify(dto.includedPaths)
          : null,
        mode: dto.mode,
        destination: JSON.stringify(dto.destination ?? {}),
        options: JSON.stringify(dto.options ?? {}),
        status: 'queued',
        agent_id: dto.destination?.agentId ?? null,
        initiated_by: user.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.runner.dispatch(run.id);
    return run;
  }

  async list(user: RequestUser, limit = 50) {
    const ids = await this.acl.visibleResourceIds(user, 'job');
    let q = this.db
      .selectFrom('restore_runs')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(Math.min(limit, 200));
    if (ids !== 'all') {
      if (ids.length === 0) return [];
      q = q.where('job_id', 'in', ids);
    }
    return q.execute();
  }

  async get(user: RequestUser, id: string) {
    const run = await this.db
      .selectFrom('restore_runs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!run) throw new NotFoundException('Restore run not found');
    if (!run.job_id) {
      // The originating job was deleted; only admins can see orphaned history.
      if (!user.isAdmin) throw new NotFoundException('Restore run not found');
    } else {
      await this.acl.assert(user, 'job', run.job_id, 'view');
    }
    return run;
  }

  async cancel(user: RequestUser, id: string) {
    const run = await this.get(user, id);
    if (run.job_id) await this.acl.assert(user, 'job', run.job_id, 'operate');
    const killed = this.runner.cancel(id);
    if (!killed && run.status === 'queued') {
      await this.db
        .updateTable('restore_runs')
        .set({ status: 'cancelled', finished_at: new Date() })
        .where('id', '=', id)
        .execute();
    }
    return { cancelled: true };
  }

  /** Resolves the download artifact path for a completed download restore. */
  async getDownload(
    user: RequestUser,
    id: string,
  ): Promise<{ path: string; filename: string }> {
    const run = await this.get(user, id);
    if (run.mode !== 'download') {
      throw new NotFoundException('Run is not a download restore');
    }
    if (run.download_expires_at && new Date(run.download_expires_at) < new Date()) {
      throw new NotFoundException('Download expired');
    }
    const dest: RestoreDestination =
      typeof run.destination === 'string'
        ? JSON.parse(run.destination)
        : run.destination;
    if (!dest.downloadRef) throw new NotFoundException('No download available');
    try {
      await fs.access(dest.downloadRef);
    } catch {
      throw new NotFoundException('Download artifact missing');
    }
    return { path: dest.downloadRef, filename: `restore-${id}.tar.gz` };
  }
}
