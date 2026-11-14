import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { promises as fs } from 'fs';
import { Db, KYSELY } from '../database/database.module';
import { AccessControlService } from '../common/access-control.service';
import { RequestUser } from '../common/auth/request-user';
import {
  CANCELLED_NO_PROCESS_MESSAGE,
  CANCELLED_ON_SERVER_AGENT_MESSAGE,
} from '../common/cancel-messages';
import { sql } from 'kysely';
import { RestoreDestination } from '../database/database.types';
import { JobsService } from '../jobs/jobs.service';
import { RestoreRunnerService } from './restore-runner.service';
import { CreateRestoreDto } from './dto/restore.dto';
import { ProxmoxRestoreSpecDto } from '../proxmox/dto/proxmox.dto';
import { ProxmoxInventory } from '../proxmox/proxmox.contract';

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

    // 'original' and 'alternate_path' write restored files to a host filesystem
    // as the restic process user — the server's own filesystem (local) or an
    // agent host — which the grant model does not cover, so both require admin.
    // 'download' only fills a managed, per-run temp dir the caller streams back,
    // so it stays an operate-level action.
    if (dto.mode !== 'download' && !user.isAdmin) {
      throw new ForbiddenException(
        'Restoring to a filesystem path requires administrator access',
      );
    }

    // Snapshot the job's repository resolution so the restore stays valid even
    // if the job is later edited or deleted.
    const job = await this.jobs.getRow(dto.jobId);

    // A VM restore runs on the agent that drives the target Hyper-V host —
    // which may be another host than the one backed up (moving a VM).
    if (dto.mode === 'hyperv') {
      const spec = dto.destination?.hyperv;
      if (job.source_kind !== 'hyperv' || !spec) {
        throw new BadRequestException(
          'A Hyper-V restore needs a Hyper-V job and destination.hyperv',
        );
      }
      if (spec.action === 'disks' && !dto.destination?.path) {
        throw new BadRequestException('Restoring disks needs a destination path');
      }
      const host = await this.db
        .selectFrom('hyperv_hosts')
        .select('agent_id')
        .where('id', '=', spec.hostId)
        .executeTakeFirst();
      if (!host) throw new BadRequestException('Unknown Hyper-V host');
      dto.destination = { ...dto.destination, agentId: host.agent_id };
      dto.includedPaths = undefined;
    } else if (dto.destination?.hyperv) {
      throw new BadRequestException('destination.hyperv only applies to the hyperv mode');
    }

    // A guest restore runs on the agent of the target node — which may be
    // another node (or cluster) than the one backed up.
    if (dto.mode === 'proxmox') {
      const spec = dto.destination?.proxmox;
      if (job.source_kind !== 'proxmox' || !spec) {
        throw new BadRequestException(
          'A Proxmox restore needs a Proxmox job and destination.proxmox',
        );
      }
      if (spec.action === 'files' && spec.guestType !== 'lxc') {
        throw new BadRequestException('Only container backups can be restored file by file');
      }
      if (spec.action === 'guest' && spec.replaceOriginal && spec.newVmid && spec.newVmid !== spec.vmid) {
        throw new BadRequestException('replaceOriginal keeps the original VMID; drop newVmid');
      }
      assertProxmoxRestoreSpec(spec, dto.includedPaths);
      const cluster = await this.db
        .selectFrom('proxmox_clusters')
        .select(['id', 'pve_cluster_id', 'inventory'])
        .where('id', '=', spec.clusterId)
        .executeTakeFirst();
      if (!cluster) throw new BadRequestException('Unknown Proxmox cluster');
      if (spec.liveRestore && spec.overlayStorage) {
        assertOverlayStorage(cluster.inventory, spec.overlayStorage, spec.targetNode);
      }
      const agent = await this.db
        .selectFrom('agents')
        .select('id')
        .where(sql<string>`proxmox_info->>'clusterId'`, '=', cluster.pve_cluster_id)
        .where(sql<string>`proxmox_info->>'node'`, '=', spec.targetNode)
        .executeTakeFirst();
      if (!agent) {
        throw new BadRequestException(`No Amber agent runs on node ${spec.targetNode}`);
      }
      dto.destination = { ...dto.destination, agentId: agent.id };
      // Selected paths only make sense for file restores.
      if (spec.action === 'guest') dto.includedPaths = undefined;
    } else if (dto.destination?.proxmox) {
      throw new BadRequestException('destination.proxmox only applies to the proxmox mode');
    }

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
        // The override is snapshotted with the repository so a queued restore
        // keeps resolving while the job is being edited.
        credential_secret_id: job.credential_secret_id,
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

  /**
   * Stops a queued or running restore. A local one is aborted by the runner,
   * which settles the row itself. Otherwise — queued, running on an agent, or
   * left `running` by a restart — the row is cancelled here; a current agent
   * notices through its task-state watch and stops restic.
   */
  async cancel(user: RequestUser, id: string) {
    const run = await this.get(user, id);
    if (run.job_id) await this.acl.assert(user, 'job', run.job_id, 'operate');
    if (run.status !== 'queued' && run.status !== 'running') {
      throw new BadRequestException(`Restore is already ${run.status}`);
    }
    if (this.runner.cancel(id)) return { cancelled: true };

    const error =
      run.status === 'queued'
        ? null
        : run.agent_id
          ? CANCELLED_ON_SERVER_AGENT_MESSAGE
          : CANCELLED_NO_PROCESS_MESSAGE;
    await this.db
      .updateTable('restore_runs')
      .set({ status: 'cancelled', finished_at: new Date(), error })
      .where('id', '=', id)
      // Don't overwrite a result that landed meanwhile.
      .where('status', 'in', ['queued', 'running'])
      .execute();
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

/** Guest-path selector of a vm-files restore: optional `[disk][pN]:` before an absolute path. */
const VM_FILES_PATH_RE = /^(?:[a-z]+[0-9]+(?:p[0-9]+)?:|p[0-9]+:)?\/.*$/;

/** Field combinations of a Proxmox restore that the DTO alone can't check. */
export function assertProxmoxRestoreSpec(
  spec: ProxmoxRestoreSpecDto,
  includedPaths: string[] | undefined,
): void {
  if (spec.action === 'vm-files') {
    if (spec.guestType !== 'qemu') {
      throw new BadRequestException('Only VM backups can restore files to a directory (use files for containers)');
    }
    const target = (spec.targetPath ?? '').replace(/\/+$/, '');
    if (!target.startsWith('/') || target.split('/').includes('..')) {
      throw new BadRequestException('vm-files needs targetPath: an absolute directory on the node other than /');
    }
    for (const p of includedPaths ?? []) {
      if (!VM_FILES_PATH_RE.test(p) || p.split('/').includes('..')) {
        throw new BadRequestException(
          `"${p}" is no guest path: use /path, p<N>:/path, <disk>:/path or <disk>p<N>:/path`,
        );
      }
    }
  } else if (spec.targetPath !== undefined) {
    throw new BadRequestException('targetPath only applies to vm-files restores');
  }
  if (spec.liveRestore) {
    if (spec.action !== 'guest' || spec.guestType !== 'qemu') {
      throw new BadRequestException('Only whole VMs can be live-restored');
    }
    if (!spec.overlayStorage) {
      throw new BadRequestException('A live restore needs overlayStorage (a dir, NFS or CIFS storage)');
    }
    if (spec.replaceOriginal) {
      throw new BadRequestException('A live restore always creates a new VM; it cannot replace the original');
    }
  } else if (spec.overlayStorage !== undefined) {
    throw new BadRequestException('overlayStorage only applies to a live restore');
  }
}

/** Storage types whose volumes are files that can be qcow2 overlays. */
const OVERLAY_STORAGE_TYPES = ['dir', 'nfs', 'cifs', 'glusterfs'];

/** With an inventory at hand, the overlay storage must exist, take images and reach the node. */
function assertOverlayStorage(inventoryColumn: unknown, storageId: string, node: string): void {
  const inventory = (
    typeof inventoryColumn === 'string' ? JSON.parse(inventoryColumn) : inventoryColumn
  ) as ProxmoxInventory | null;
  if (!inventory) return;
  const st = inventory.storages.find((s) => s.id === storageId);
  if (!st) throw new BadRequestException(`Unknown storage ${storageId}`);
  if (!OVERLAY_STORAGE_TYPES.includes(st.type) || !st.content.includes('images')) {
    throw new BadRequestException(
      `Storage ${storageId} (${st.type}) cannot hold qcow2 overlays; pick a dir, NFS or CIFS storage with disk images`,
    );
  }
  if (st.nodes.length > 0 && !st.nodes.includes(node)) {
    throw new BadRequestException(`Storage ${storageId} is not available on node ${node}`);
  }
}
