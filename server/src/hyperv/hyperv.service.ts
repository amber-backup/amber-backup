import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Db, KYSELY } from '../database/database.module';
import {
  HypervCredential,
  HypervHost,
  HypervInventory,
  HypervJobConfig,
  RunStats,
} from '../database/database.types';
import { SecretsService } from '../crypto/secrets.service';
import { uniqueSlug } from '../common/slug';
import { RequestUser } from '../common/auth/request-user';
import { AccessControlService } from '../common/access-control.service';
import { ResticService } from '../restic/restic.service';
import { ResticSnapshot } from '../restic/restic.types';
import { TargetsService } from '../targets/targets.service';
import { JobsService } from '../jobs/jobs.service';
import {
  HYPERV_INVENTORY_TASK_PREFIX,
  HypervConnection,
  HypervVmRunResult,
  vmTag,
} from './hyperv.contract';
import { CreateHypervHostDto, UpdateHypervHostDto } from './dto/hyperv.dto';

/** An inventory older than this is refreshed on the agent's next poll. */
const INVENTORY_MAX_AGE_MS = 15 * 60_000;

/** A host as the API returns it: no secret reference, plus its agent. */
export interface PublicHypervHost
  extends Omit<HypervHost, 'credential_secret_id' | 'inventory'> {
  /** remote: the stored user name (never the password). */
  username: string | null;
  agent_name: string | null;
  agent_status: string | null;
  vm_count: number | null;
}

/** Per-VM protection: which jobs cover the VM and how its last backup went. */
export interface VmProtection {
  vmId: string;
  jobs: { id: string; name: string; enabled: boolean }[];
  lastBackup: (HypervVmRunResult & { jobId: string; finishedAt: Date | null }) | null;
}

export interface HypervHostDetail extends PublicHypervHost {
  inventory: HypervInventory | null;
  protection: VmProtection[];
}

/** Hyper-V hosts, their VM inventory and the agent tasks around them. */
@Injectable()
export class HypervService {
  private readonly logger = new Logger(HypervService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly secrets: SecretsService,
    private readonly acl: AccessControlService,
    private readonly restic: ResticService,
    private readonly targets: TargetsService,
    private readonly jobs: JobsService,
  ) {}

  // --- Hosts ------------------------------------------------------------------

  private hostQuery() {
    return this.db
      .selectFrom('hyperv_hosts as h')
      .leftJoin('agents as a', 'a.id', 'h.agent_id')
      .selectAll('h')
      .select(['a.name as agent_name', 'a.status as agent_status']);
  }

  private async toPublic(
    row: HypervHost & { agent_name: string | null; agent_status: string | null },
  ): Promise<PublicHypervHost> {
    const { credential_secret_id, inventory, ...rest } = row;
    const inv = parseJson<HypervInventory>(inventory);
    let username: string | null = null;
    if (credential_secret_id) {
      username = (await this.credential(credential_secret_id)).username;
    }
    return { ...rest, username, vm_count: inv ? inv.vms.length : null };
  }

  async list(): Promise<PublicHypervHost[]> {
    const rows = await this.hostQuery().orderBy('h.name', 'asc').execute();
    return Promise.all(rows.map((r) => this.toPublic(r)));
  }

  async getRow(id: string): Promise<HypervHost> {
    const row = await this.db
      .selectFrom('hyperv_hosts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Hyper-V host not found');
    return row;
  }

  async get(id: string): Promise<HypervHostDetail> {
    const row = await this.hostQuery().where('h.id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('Hyper-V host not found');
    const inventory = parseJson<HypervInventory>(row.inventory);
    return {
      ...(await this.toPublic(row)),
      inventory,
      protection: await this.protection(id, inventory),
    };
  }

  async create(user: RequestUser, dto: CreateHypervHostDto): Promise<HypervHostDetail> {
    await this.assertAgent(dto.agentId);
    if (dto.mode === 'local') await this.assertNoLocalHost(dto.agentId);
    const secretId =
      dto.mode === 'remote'
        ? await this.secrets.create(
            'hyperv_credential',
            JSON.stringify({ username: dto.username!, password: dto.password! }),
          )
        : null;
    const row = await this.db
      .insertInto('hyperv_hosts')
      .values({
        name: dto.name,
        slug: await uniqueSlug(this.db, 'hyperv_hosts', dto.name),
        mode: dto.mode,
        agent_id: dto.agentId,
        address: dto.mode === 'remote' ? dto.address! : null,
        credential_secret_id: secretId,
        // The first inventory is fetched on the agent's next poll.
        inventory_requested_at: new Date(),
        owner_id: user.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return this.get(row.id);
  }

  async update(id: string, dto: UpdateHypervHostDto): Promise<HypervHostDetail> {
    const host = await this.getRow(id);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (dto.name !== undefined) {
      patch.name = dto.name;
      patch.slug = await uniqueSlug(this.db, 'hyperv_hosts', dto.name, id);
    }
    if (dto.agentId !== undefined && dto.agentId !== host.agent_id) {
      await this.assertAgent(dto.agentId);
      if (host.mode === 'local') await this.assertNoLocalHost(dto.agentId);
      patch.agent_id = dto.agentId;
      patch.inventory_requested_at = new Date();
    }
    const remoteChange =
      dto.address !== undefined || dto.username !== undefined || dto.password !== undefined;
    if (remoteChange) {
      if (host.mode !== 'remote') {
        throw new BadRequestException('Only a remote host has an address and credentials');
      }
      if (dto.address !== undefined) patch.address = dto.address;
      if (dto.username !== undefined || dto.password !== undefined) {
        const current = await this.credential(host.credential_secret_id!);
        await this.secrets.update(
          host.credential_secret_id!,
          JSON.stringify({
            username: dto.username ?? current.username,
            password: dto.password ?? current.password,
          }),
        );
      }
      patch.inventory_requested_at = new Date();
    }
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('hyperv_hosts').set(patch).where('id', '=', id).execute();
      // A Hyper-V job runs on its host's agent: it moves along.
      if (patch.agent_id) {
        await trx
          .updateTable('backup_jobs')
          .set({ agent_id: patch.agent_id as string, updated_at: new Date() })
          .where('hyperv_host_id', '=', id)
          .execute();
      }
    });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const host = await this.getRow(id);
    const job = await this.db
      .selectFrom('backup_jobs')
      .select('name')
      .where('hyperv_host_id', '=', id)
      .executeTakeFirst();
    if (job) {
      throw new ConflictException(
        `The host is still backed up by job "${job.name}"; delete or move its jobs first`,
      );
    }
    await this.db.deleteFrom('hyperv_hosts').where('id', '=', id).execute();
    if (host.credential_secret_id) await this.secrets.remove(host.credential_secret_id);
  }

  /** Asks the host's agent for a fresh inventory on its next poll. */
  async requestInventory(id: string): Promise<{ requestedAt: Date }> {
    await this.getRow(id);
    const requestedAt = new Date();
    await this.db
      .updateTable('hyperv_hosts')
      .set({ inventory_requested_at: requestedAt })
      .where('id', '=', id)
      .execute();
    return { requestedAt };
  }

  /** Queues a refresh for every host whose inventory has gone stale. */
  @Interval(60_000)
  async requestStaleInventories(): Promise<void> {
    const cutoff = new Date(Date.now() - INVENTORY_MAX_AGE_MS);
    await this.db
      .updateTable('hyperv_hosts')
      .set({ inventory_requested_at: new Date() })
      .where('inventory_requested_at', 'is', null)
      .where((eb) => eb.or([eb('inventory_at', 'is', null), eb('inventory_at', '<', cutoff)]))
      .execute()
      .catch((e) => this.logger.warn(`Inventory refresh scheduling failed: ${e}`));
  }

  private async assertAgent(agentId: string): Promise<void> {
    const agent = await this.db
      .selectFrom('agents')
      .select('id')
      .where('id', '=', agentId)
      .executeTakeFirst();
    if (!agent) throw new BadRequestException('Unknown agent');
  }

  private async assertNoLocalHost(agentId: string): Promise<void> {
    const taken = await this.db
      .selectFrom('hyperv_hosts')
      .select('name')
      .where('agent_id', '=', agentId)
      .where('mode', '=', 'local')
      .executeTakeFirst();
    if (taken) {
      throw new ConflictException(
        `This agent already runs on Hyper-V host "${taken.name}"`,
      );
    }
  }

  private async credential(secretId: string): Promise<HypervCredential> {
    return JSON.parse(await this.secrets.reveal(secretId)) as HypervCredential;
  }

  // --- Agent side ---------------------------------------------------------------

  /** How the agent reaches a host; remote credentials are decrypted for the task only. */
  async connection(host: HypervHost): Promise<HypervConnection> {
    if (host.mode === 'local') return { mode: 'local' };
    const cred = await this.credential(host.credential_secret_id!);
    return {
      mode: 'remote',
      address: host.address!,
      username: cred.username,
      password: cred.password,
    };
  }

  /** Claims the pending inventory refreshes of the hosts this agent drives. */
  async claimInventoryTasks(agentId: string) {
    const hosts = await this.db
      .updateTable('hyperv_hosts')
      .set({ inventory_requested_at: null })
      .where('agent_id', '=', agentId)
      .where('inventory_requested_at', 'is not', null)
      .returningAll()
      .execute();
    const tasks = [];
    for (const host of hosts) {
      tasks.push({
        type: 'hyperv-inventory' as const,
        taskId: HYPERV_INVENTORY_TASK_PREFIX + host.id,
        repository: '',
        password: '',
        env: {},
        credentialFiles: [],
        hyperv: { connection: await this.connection(host) },
      });
    }
    return tasks;
  }

  /** Stores the inventory an agent read, if the host is this agent's. */
  async recordInventory(
    agentId: string,
    hostId: string,
    result: { status: string; inventory?: HypervInventory; error?: string },
  ): Promise<void> {
    const host = await this.db
      .selectFrom('hyperv_hosts')
      .select(['id', 'agent_id'])
      .where('id', '=', hostId)
      .executeTakeFirst();
    if (!host || host.agent_id !== agentId) {
      throw new NotFoundException('Task not found for this agent');
    }
    if (result.status === 'success' && result.inventory) {
      await this.db
        .updateTable('hyperv_hosts')
        .set({
          inventory: JSON.stringify(result.inventory),
          inventory_at: new Date(),
          inventory_error: null,
        })
        .where('id', '=', hostId)
        .execute();
      return;
    }
    await this.db
      .updateTable('hyperv_hosts')
      .set({ inventory_error: result.error ?? 'Reading the inventory failed', inventory_at: new Date() })
      .where('id', '=', hostId)
      .execute();
  }

  /**
   * A restore that replaced a VM registered it anew, with a new id. Jobs that
   * selected the old VM by id follow it, so the restored VM stays protected.
   */
  async followReplacedVm(oldVmId: string, newVmId: string): Promise<void> {
    const jobs = await this.db
      .selectFrom('backup_jobs')
      .select(['id', 'hyperv_config'])
      .where('source_kind', '=', 'hyperv')
      .execute();
    for (const job of jobs) {
      const config = parseJson<HypervJobConfig>(job.hyperv_config);
      if (!config) continue;
      const mentions = [...config.vmIds, ...(config.excludeVmIds ?? [])].some((id) =>
        sameId(id, oldVmId),
      );
      if (!mentions) continue;
      const swap = (ids: string[] | undefined) =>
        (ids ?? []).map((id) => (sameId(id, oldVmId) ? newVmId.toLowerCase() : id));
      const next = { ...config, vmIds: swap(config.vmIds), excludeVmIds: swap(config.excludeVmIds) };
      await this.db
        .updateTable('backup_jobs')
        .set({ hyperv_config: JSON.stringify(next), updated_at: new Date() })
        .where('id', '=', job.id)
        .execute();
      this.logger.log(`Job ${job.id} now backs up VM ${newVmId} (replaced ${oldVmId})`);
    }
  }

  // --- Protection & snapshots ----------------------------------------------------

  /** Which jobs cover each VM of the inventory, and its latest backup result. */
  private async protection(
    hostId: string,
    inventory: HypervInventory | null,
  ): Promise<VmProtection[]> {
    if (!inventory) return [];
    const jobs = await this.db
      .selectFrom('backup_jobs')
      .select(['id', 'name', 'enabled', 'hyperv_config'])
      .where('hyperv_host_id', '=', hostId)
      .execute();
    const runs = jobs.length
      ? await this.db
          .selectFrom('job_runs')
          .distinctOn('job_id')
          .select(['job_id', 'stats', 'finished_at'])
          .where('job_id', 'in', jobs.map((j) => j.id))
          .where('kind', '=', 'backup')
          .where('finished_at', 'is not', null)
          .orderBy('job_id')
          .orderBy('finished_at', 'desc')
          .execute()
      : [];
    return inventory.vms.map((vm) => {
      const covering = jobs.filter((j) =>
        coversVm(parseJson<HypervJobConfig>(j.hyperv_config), vm.id),
      );
      let lastBackup: VmProtection['lastBackup'] = null;
      for (const run of runs) {
        if (!covering.some((j) => j.id === run.job_id)) continue;
        const stats = parseJson<RunStats & { hypervVms?: HypervVmRunResult[] }>(run.stats);
        const r = stats?.hypervVms?.find((v) => sameId(v.vmId, vm.id));
        if (r && (!lastBackup || (run.finished_at ?? 0) > (lastBackup.finishedAt ?? 0))) {
          lastBackup = { ...r, jobId: run.job_id, finishedAt: run.finished_at };
        }
      }
      return {
        vmId: vm.id,
        jobs: covering.map(({ id, name, enabled }) => ({ id, name, enabled })),
        lastBackup,
      };
    });
  }

  /**
   * Snapshots of one VM across the Hyper-V jobs the user may view, newest
   * first. A VM moved between hosts keeps its id, so every Hyper-V job is
   * searched, not only this host's.
   */
  async vmSnapshots(
    user: RequestUser,
    vmId: string,
  ): Promise<{ jobId: string; jobName: string; snapshot: ResticSnapshot }[]> {
    const visible = await this.acl.visibleResourceIds(user, 'job');
    let q = this.db
      .selectFrom('backup_jobs')
      .select(['id', 'name'])
      .where('source_kind', '=', 'hyperv');
    if (visible !== 'all') {
      if (visible.length === 0) return [];
      q = q.where('id', 'in', visible);
    }
    const out: { jobId: string; jobName: string; snapshot: ResticSnapshot }[] = [];
    for (const job of await q.execute()) {
      const ctx = await this.targets.resolveForJob(await this.jobs.getRow(job.id));
      try {
        for (const snapshot of await this.restic.snapshots(ctx, { tags: [vmTag(vmId)] })) {
          out.push({ jobId: job.id, jobName: job.name, snapshot });
        }
      } catch (e) {
        this.logger.warn(`Listing snapshots of job ${job.id} failed: ${e}`);
      }
    }
    out.sort((a, b) => (a.snapshot.time < b.snapshot.time ? 1 : -1));
    return out;
  }
}

/** Whether a job's selection includes the VM. */
export function coversVm(config: HypervJobConfig | null, vmId: string): boolean {
  if (!config) return false;
  if (config.allVms) return !(config.excludeVmIds ?? []).some((id) => sameId(id, vmId));
  return config.vmIds.some((id) => sameId(id, vmId));
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null;
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}
