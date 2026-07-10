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
import { RestoreRunnerService } from './restore-runner.service';
import { CreateRestoreDto } from './dto/restore.dto';

@Injectable()
export class RestoreService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly acl: AccessControlService,
    private readonly runner: RestoreRunnerService,
  ) {}

  async create(user: RequestUser, dto: CreateRestoreDto) {
    // Restore is an 'operate' action on the target (§10.6).
    await this.acl.assert(user, 'target', dto.targetId, 'operate');

    // Restoring onto an agent host reaches into agent territory → admin-only.
    if (dto.destination?.agentId && !user.isAdmin) {
      throw new ForbiddenException(
        'Restoring onto an agent host requires administrator access',
      );
    }

    const run = await this.db
      .insertInto('restore_runs')
      .values({
        target_id: dto.targetId,
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
    const ids = await this.acl.visibleResourceIds(user, 'target');
    let q = this.db
      .selectFrom('restore_runs')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(Math.min(limit, 200));
    if (ids !== 'all') {
      if (ids.length === 0) return [];
      q = q.where('target_id', 'in', ids);
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
    await this.acl.assert(user, 'target', run.target_id, 'view');
    return run;
  }

  async cancel(user: RequestUser, id: string) {
    const run = await this.get(user, id);
    await this.acl.assert(user, 'target', run.target_id, 'operate');
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
