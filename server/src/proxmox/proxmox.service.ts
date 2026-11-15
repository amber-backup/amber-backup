import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { sql } from 'kysely';
import { Db, KYSELY } from '../database/database.module';
import {
  ProxmoxCluster,
  ProxmoxRunItemStatus,
  ResticOptions,
} from '../database/database.types';
import { uniqueSlug } from '../common/slug';
import { RequestUser } from '../common/auth/request-user';
import { AccessControlService } from '../common/access-control.service';
import { CANCELLED_ON_AGENT_MESSAGE } from '../common/cancel-messages';
import { ResticService } from '../restic/restic.service';
import { ResticSnapshot } from '../restic/restic.types';
import { TargetsService } from '../targets/targets.service';
import { JobsService } from '../jobs/jobs.service';
import { RunRetryService } from '../jobs/run-retry.service';
import { PruneRunnerService } from '../jobs/prune-runner.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { repositoryKnownInitialized } from '../repositories/repository-initialized';
import type { AgentTask } from '../agents/agents.service';
import type { TaskResultDto } from '../agents/dto/agent.dto';
import {
  AGENT_LOST_TASK_MESSAGE,
  AGENT_STOPPED_REPORTING_MESSAGE,
  agentWaitSeconds,
  LEASE_EXPIRED_MESSAGES,
  configuredLeaseTimeouts,
  leaseExpiredSql,
  runIds,
} from '../agents/run-lease';
import { loadConfig } from '../config/configuration';
import {
  PROXMOX_INVENTORY_TASK_PREFIX,
  PROXMOX_RETENTION_TASK_PREFIX,
  ProxmoxAgentInfo,
  ProxmoxCandidate,
  ProxmoxClusterDetail,
  ProxmoxGuestProtection,
  ProxmoxGuestResult,
  ProxmoxGuestType,
  ProxmoxInventory,
  ProxmoxJobConfig,
  ProxmoxNodeView,
  ProxmoxRestoreSpec,
  ProxmoxRunItemView,
  ProxmoxSummary,
  ProxmoxTaskPayload,
  PublicProxmoxCluster,
  pveClusterTag,
  pveGuestTag,
} from './proxmox.contract';
import {
  ClaimCandidate,
  MAX_ITEM_MOVES,
  SettledItem,
  aggregateProgress,
  coversGuest,
  isOpen,
  pickClaimable,
  runLog,
  runOutcome,
  selectGuests,
  summarize,
} from './proxmox.logic';
import { UpdateProxmoxClusterDto } from './dto/proxmox.dto';

/** An inventory older than this is refreshed on a node agent's next poll. */
const INVENTORY_MAX_AGE_MS = 15 * 60_000;
/** A run expands against an inventory at most this old … */
const EXPANSION_INVENTORY_MAX_AGE_MS = 10 * 60_000;
/** … or waits this long for a fresh one before using what it has. */
const EXPANSION_WAIT_MS = 2 * 60_000;
/** A pending finishing task nobody claims is skipped after this long. */
const RETENTION_UNCLAIMED_MS = 30 * 60_000;
/** A claimed finishing task without a result is given up after this long. */
const RETENTION_RUNNING_MS = 6 * 3600_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ClusterJoinRow = ProxmoxCluster & { agent_name: string | null; agent_status: string | null };

interface NodeAgent {
  id: string;
  name: string;
  status: string;
  last_seen_at: Date | null;
  poll_interval_seconds?: number;
  info: ProxmoxAgentInfo;
}

/** Proxmox clusters, their inventory, and the run/agent lifecycle around them. */
@Injectable()
export class ProxmoxService {
  private readonly logger = new Logger(ProxmoxService.name);
  /** Leases never count from before this process started (the server may have been down). */
  private readonly startedAt = new Date();

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly acl: AccessControlService,
    private readonly restic: ResticService,
    private readonly targets: TargetsService,
    private readonly jobs: JobsService,
    private readonly retries: RunRetryService,
    private readonly pruneRunner: PruneRunnerService,
    private readonly repositories: RepositoriesService,
  ) {}

  // --- Clusters -------------------------------------------------------------------

  private clusterQuery() {
    return this.db
      .selectFrom('proxmox_clusters as c')
      .leftJoin('agents as a', 'a.id', 'c.primary_agent_id')
      .selectAll('c')
      .select(['a.name as agent_name', 'a.status as agent_status']);
  }

  private toPublic(row: ClusterJoinRow): PublicProxmoxCluster {
    const { inventory, ...rest } = row;
    const inv = parseJson<ProxmoxInventory>(inventory);
    return {
      ...rest,
      guest_count: inv ? inv.guests.length : null,
      node_count: inv ? inv.nodes.length : null,
    };
  }

  async list(): Promise<PublicProxmoxCluster[]> {
    const rows = await this.clusterQuery().orderBy('c.name', 'asc').execute();
    return rows.map((r) => this.toPublic(r as ClusterJoinRow));
  }

  async getRow(id: string): Promise<ProxmoxCluster> {
    const row = await this.db
      .selectFrom('proxmox_clusters')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Proxmox cluster not found');
    return row;
  }

  async get(id: string): Promise<ProxmoxClusterDetail> {
    const row = await this.clusterQuery().where('c.id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('Proxmox cluster not found');
    const inventory = parseJson<ProxmoxInventory>(row.inventory);
    const agents = await this.nodeAgents(row.pve_cluster_id);
    return {
      ...this.toPublic(row as ClusterJoinRow),
      inventory,
      nodes: nodeViews(inventory, agents),
      protection: await this.protection(id, inventory),
    };
  }

  /**
   * Registers the PVE cluster a node agent announces, unless Amber knows it
   * already. Clusters are not added by hand: the first node agent to poll
   * creates the row and becomes its primary agent; the other nodes' agents
   * link up through the same cluster id. Returns the cluster, also when a
   * concurrent poll of another node created it.
   */
  async registerCluster(agentId: string, info: ProxmoxAgentInfo): Promise<ProxmoxCluster | null> {
    const name = info.clusterName || info.node;
    const created = await this.db
      .insertInto('proxmox_clusters')
      .values({
        name,
        slug: await uniqueSlug(this.db, 'proxmox_clusters', name),
        pve_cluster_id: info.clusterId,
        cluster_name: info.clusterName ?? null,
        primary_agent_id: agentId,
        // The first inventory is read on this very poll.
        inventory_requested_at: new Date(),
        owner_id: null,
      })
      .onConflict((oc) => oc.column('pve_cluster_id').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (created) {
      this.logger.log(`Registered Proxmox cluster "${name}" (announced by the agent on node ${info.node})`);
      return created;
    }
    return this.clusterOf(info);
  }

  async update(id: string, dto: UpdateProxmoxClusterDto): Promise<ProxmoxClusterDetail> {
    const cluster = await this.getRow(id);
    const patch: { name?: string; cluster_name?: string | null } = {};
    // The slug is frozen at creation: it is part of the restic host and the
    // cluster tag of every snapshot (`pveResticHost`, `pveClusterTag`), which
    // retention and the per-guest snapshot list filter by. Re-deriving it on a
    // rename would orphan all earlier snapshots (never forgotten, no longer
    // listed). A rename changes the display name only.
    if (dto.name !== undefined) patch.name = dto.name;
    let primaryAgentId: string | undefined;
    if (dto.primaryAgentId !== undefined && dto.primaryAgentId !== cluster.primary_agent_id) {
      const info = await this.agentInfo(dto.primaryAgentId);
      if (info.clusterId !== cluster.pve_cluster_id) {
        throw new BadRequestException('The agent runs on a node of another PVE cluster');
      }
      primaryAgentId = dto.primaryAgentId;
      patch.cluster_name = info.clusterName ?? null;
    }
    await this.setCluster(id, patch, primaryAgentId);
    return this.get(id);
  }

  /** Updates a cluster; a new primary agent takes the cluster's jobs along. */
  private async setCluster(
    id: string,
    patch: { name?: string; cluster_name?: string | null },
    primaryAgentId?: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('proxmox_clusters')
        .set({
          ...patch,
          ...(primaryAgentId ? { primary_agent_id: primaryAgentId } : {}),
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .execute();
      // The primary agent is the agent of every job of the cluster: they follow.
      if (primaryAgentId) {
        await trx
          .updateTable('backup_jobs')
          .set({ agent_id: primaryAgentId, updated_at: new Date() })
          .where('proxmox_cluster_id', '=', id)
          .execute();
      }
    });
  }

  /** The first job that backs up a cluster, or undefined. */
  private async jobOfCluster(id: string) {
    return this.db
      .selectFrom('backup_jobs')
      .select('name')
      .where('proxmox_cluster_id', '=', id)
      .executeTakeFirst();
  }

  /**
   * Removes a cluster Amber no longer reaches. While an agent still announces
   * it, its next poll would register it again — such a cluster goes away with
   * its last agent (`releaseAgent`).
   */
  async remove(id: string): Promise<void> {
    const cluster = await this.getRow(id);
    const job = await this.jobOfCluster(id);
    if (job) {
      throw new ConflictException(
        `The cluster is still backed up by job "${job.name}"; delete its jobs first`,
      );
    }
    const [agent] = await this.nodeAgents(cluster.pve_cluster_id);
    if (agent) {
      throw new ConflictException(
        `Agent "${agent.name}" still runs on a node of this cluster and would register it again on its next poll; delete the agents of its nodes instead`,
      );
    }
    await this.db.deleteFrom('proxmox_clusters').where('id', '=', id).execute();
  }

  /**
   * Before an agent is deleted: every cluster it is the primary agent of goes
   * to another node agent of that cluster (an online one first), or — with
   * its last agent — is removed. A cluster that jobs still back up keeps its
   * last agent (ConflictException).
   */
  async releaseAgent(agentId: string): Promise<void> {
    const clusters = await this.db
      .selectFrom('proxmox_clusters')
      .selectAll()
      .where('primary_agent_id', '=', agentId)
      .execute();
    for (const cluster of clusters) {
      const successor = (await this.nodeAgents(cluster.pve_cluster_id))
        .filter((a) => a.id !== agentId)
        .sort((a, b) => Number(b.status === 'online') - Number(a.status === 'online'))[0];
      if (successor) {
        await this.setCluster(cluster.id, {}, successor.id);
        continue;
      }
      const job = await this.jobOfCluster(cluster.id);
      if (job) {
        throw new ConflictException(
          `The agent is the last agent of Proxmox cluster "${cluster.name}", which job "${job.name}" still backs up; delete its jobs first`,
        );
      }
      await this.db.deleteFrom('proxmox_clusters').where('id', '=', cluster.id).execute();
    }
  }

  async requestInventory(id: string): Promise<{ requestedAt: Date }> {
    await this.getRow(id);
    const requestedAt = new Date();
    await this.db
      .updateTable('proxmox_clusters')
      .set({ inventory_requested_at: requestedAt })
      .where('id', '=', id)
      .execute();
    return { requestedAt };
  }

  /** Agents on PVE nodes (the choices for a cluster's primary agent). */
  async candidates(): Promise<ProxmoxCandidate[]> {
    const agents = await this.db
      .selectFrom('agents')
      .select(['id', 'name', 'status', 'proxmox_info'])
      .where('proxmox_info', 'is not', null)
      .orderBy('name', 'asc')
      .execute();
    const clusters = await this.db
      .selectFrom('proxmox_clusters')
      .select(['id', 'pve_cluster_id'])
      .execute();
    const byPveId = new Map(clusters.map((c) => [c.pve_cluster_id, c.id]));
    return agents.flatMap((a) => {
      const info = parseJson<ProxmoxAgentInfo>(a.proxmox_info);
      if (!info) return [];
      return [
        {
          agentId: a.id,
          agentName: a.name,
          agentStatus: a.status,
          info,
          registeredClusterId: byPveId.get(info.clusterId) ?? null,
        },
      ];
    });
  }

  private async agentInfo(agentId: string): Promise<ProxmoxAgentInfo> {
    const agent = await this.db
      .selectFrom('agents')
      .select(['id', 'proxmox_info'])
      .where('id', '=', agentId)
      .executeTakeFirst();
    if (!agent) throw new BadRequestException('Unknown agent');
    const info = parseJson<ProxmoxAgentInfo>(agent.proxmox_info);
    if (!info) {
      throw new BadRequestException(
        'The agent does not run on a Proxmox VE node (or is too old to announce it)',
      );
    }
    return info;
  }

  /** The agents running on the nodes of a cluster (linked by their poll announcement). */
  async nodeAgents(pveClusterId: string): Promise<NodeAgent[]> {
    const rows = await this.db
      .selectFrom('agents')
      .select(['id', 'name', 'status', 'last_seen_at', 'poll_interval_seconds', 'proxmox_info'])
      .where(sql<string>`proxmox_info->>'clusterId'`, '=', pveClusterId)
      .execute();
    return rows.flatMap((r) => {
      const info = parseJson<ProxmoxAgentInfo>(r.proxmox_info);
      return info
        ? [
            {
              id: r.id,
              name: r.name,
              status: r.status,
              last_seen_at: r.last_seen_at,
              poll_interval_seconds: r.poll_interval_seconds,
              info,
            },
          ]
        : [];
    });
  }

  /** Queues a refresh for every cluster whose inventory has gone stale. */
  @Interval(60_000)
  async requestStaleInventories(): Promise<void> {
    const cutoff = new Date(Date.now() - INVENTORY_MAX_AGE_MS);
    await this.db
      .updateTable('proxmox_clusters')
      .set({ inventory_requested_at: new Date() })
      .where('inventory_requested_at', 'is', null)
      .where((eb) => eb.or([eb('inventory_at', 'is', null), eb('inventory_at', '<', cutoff)]))
      .execute()
      .catch((e) => this.logger.warn(`Inventory refresh scheduling failed: ${e}`));
  }

  // --- Protection, summary, snapshots -----------------------------------------------

  private async protection(
    clusterId: string,
    inventory: ProxmoxInventory | null,
  ): Promise<ProxmoxGuestProtection[]> {
    if (!inventory) return [];
    const jobs = await this.db
      .selectFrom('backup_jobs')
      .select(['id', 'name', 'enabled', 'proxmox_config'])
      .where('proxmox_cluster_id', '=', clusterId)
      .execute();
    const guests = jobs.length
      ? await this.db
          .selectFrom('proxmox_job_guests')
          .select(['job_id', 'vmid', 'last_result', 'last_finished_at'])
          .where('job_id', 'in', jobs.map((j) => j.id))
          .execute()
      : [];
    return inventory.guests.map((guest) => {
      const covering = jobs.filter((j) =>
        coversGuest(parseJson<ProxmoxJobConfig>(j.proxmox_config), guest),
      );
      let lastBackup: ProxmoxGuestProtection['lastBackup'] = null;
      for (const g of guests) {
        if (g.vmid !== guest.vmid || !covering.some((j) => j.id === g.job_id)) continue;
        const result = parseJson<ProxmoxGuestResult>(g.last_result);
        if (!result) continue;
        if (!lastBackup || (g.last_finished_at ?? 0) > (lastBackup.finishedAt ?? 0)) {
          lastBackup = { ...result, jobId: g.job_id, finishedAt: g.last_finished_at };
        }
      }
      return {
        vmid: guest.vmid,
        jobs: covering.map(({ id, name, enabled }) => ({ id, name, enabled })),
        lastBackup,
      };
    });
  }

  /** What needs attention across all clusters. Feeds the dashboard. */
  async summary(): Promise<ProxmoxSummary> {
    const clusters = await this.db
      .selectFrom('proxmox_clusters')
      .select(['id', 'name', 'pve_cluster_id', 'inventory'])
      .orderBy('name', 'asc')
      .execute();
    const out: ProxmoxSummary = {
      clusters: clusters.length,
      guests: 0,
      unprotected: [],
      failed: [],
      nodesWithoutAgent: [],
    };
    for (const cluster of clusters) {
      const inventory = parseJson<ProxmoxInventory>(cluster.inventory);
      if (!inventory) continue;
      out.guests += inventory.guests.length;
      const byVmid = new Map(inventory.guests.map((g) => [g.vmid, g]));
      for (const p of await this.protection(cluster.id, inventory)) {
        const g = byVmid.get(p.vmid)!;
        if (g.template) continue;
        const issue = {
          clusterId: cluster.id,
          clusterName: cluster.name,
          vmid: p.vmid,
          name: g.name,
          type: g.type,
        };
        if (p.jobs.length === 0) out.unprotected.push(issue);
        else if (p.lastBackup?.status === 'failed') {
          out.failed.push({ ...issue, error: p.lastBackup.error, finishedAt: p.lastBackup.finishedAt });
        }
      }
      const withAgent = new Set(
        (await this.nodeAgents(cluster.pve_cluster_id)).map((a) => a.info.node),
      );
      const withGuests = new Set(inventory.guests.map((g) => g.node));
      for (const node of inventory.nodes) {
        if (withGuests.has(node.name) && !withAgent.has(node.name)) {
          out.nodesWithoutAgent.push({ clusterId: cluster.id, clusterName: cluster.name, node: node.name });
        }
      }
    }
    return out;
  }

  /** Snapshots of one guest across the cluster's jobs the user may view, newest first. */
  async guestSnapshots(
    user: RequestUser,
    clusterId: string,
    vmid: number,
  ): Promise<{ jobId: string; jobName: string; snapshot: ResticSnapshot }[]> {
    const cluster = await this.getRow(clusterId);
    const visible = await this.acl.visibleResourceIds(user, 'job');
    let q = this.db
      .selectFrom('backup_jobs')
      .select(['id', 'name'])
      .where('source_kind', '=', 'proxmox')
      .where('proxmox_cluster_id', '=', clusterId);
    if (visible !== 'all') {
      if (visible.length === 0) return [];
      q = q.where('id', 'in', visible);
    }
    const out: { jobId: string; jobName: string; snapshot: ResticSnapshot }[] = [];
    const seen = new Set<string>();
    // One --tag with a comma list = all of these tags (restic ANDs within one).
    const tags = [`${pveClusterTag(cluster.slug)},${pveGuestTag(vmid)}`];
    for (const job of await q.execute()) {
      const ctx = await this.targets.resolveForJob(await this.jobs.getRow(job.id));
      try {
        for (const snapshot of await this.restic.snapshots(ctx, { tags })) {
          if (seen.has(snapshot.id)) continue;
          seen.add(snapshot.id);
          out.push({ jobId: job.id, jobName: job.name, snapshot });
        }
      } catch (e) {
        this.logger.warn(`Listing snapshots of job ${job.id} failed: ${e}`);
      }
    }
    out.sort((a, b) => (a.snapshot.time < b.snapshot.time ? 1 : -1));
    return out;
  }

  /** A run's per-guest rows. */
  async runItems(user: RequestUser, runId: string): Promise<ProxmoxRunItemView[]> {
    const run = await this.db
      .selectFrom('job_runs')
      .select(['id', 'job_id'])
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!run) throw new NotFoundException('Run not found');
    await this.acl.assert(user, 'job', run.job_id, 'view');
    const items = await this.db
      .selectFrom('proxmox_run_items')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('vmid', 'asc')
      .execute();
    return items.map((i) => ({
      id: i.id,
      vmid: i.vmid,
      guestType: i.guest_type,
      name: i.name,
      node: i.node,
      agentId: i.agent_id,
      status: i.status,
      method: i.method,
      result: parseJson<ProxmoxGuestResult>(i.result),
      progress: parseJson<Record<string, unknown>>(i.progress),
      error: i.error,
      startedAt: i.started_at,
      finishedAt: i.finished_at,
    }));
  }

  // --- Agent side: poll --------------------------------------------------------------

  private async clusterOf(info: ProxmoxAgentInfo | undefined): Promise<ProxmoxCluster | null> {
    if (!info) return null;
    const row = await this.db
      .selectFrom('proxmox_clusters')
      .selectAll()
      .where('pve_cluster_id', '=', info.clusterId)
      .executeTakeFirst();
    return row ?? null;
  }

  /** Whether this agent may take cluster-wide tasks (primary, or any node while it is offline). */
  private async mayCoordinate(agentId: string, cluster: ProxmoxCluster): Promise<boolean> {
    if (agentId === cluster.primary_agent_id) return true;
    const primary = await this.db
      .selectFrom('agents')
      .select('status')
      .where('id', '=', cluster.primary_agent_id)
      .executeTakeFirst();
    return primary?.status !== 'online';
  }

  /**
   * Everything a node agent gets on its poll: the cluster's inventory refresh,
   * the guests of its node that are due, and finishing tasks of settled runs.
   */
  async claimTasks(agentId: string, info: ProxmoxAgentInfo | undefined): Promise<AgentTask[]> {
    if (!info) return [];
    const cluster = (await this.clusterOf(info)) ?? (await this.registerCluster(agentId, info));
    if (!cluster) return [];
    const tasks: AgentTask[] = [];
    const coordinate = await this.mayCoordinate(agentId, cluster);
    if (coordinate) {
      const inv = await this.claimInventory(cluster);
      if (inv) tasks.push(inv);
    }
    await this.expandQueuedRuns(cluster.id);
    tasks.push(...(await this.claimItems(agentId, info.node, cluster)));
    if (coordinate) tasks.push(...(await this.claimRetention(agentId, cluster)));
    return tasks;
  }

  private async claimInventory(cluster: ProxmoxCluster): Promise<AgentTask | null> {
    const claimed = await this.db
      .updateTable('proxmox_clusters')
      .set({ inventory_requested_at: null })
      .where('id', '=', cluster.id)
      .where('inventory_requested_at', 'is not', null)
      .returning('id')
      .executeTakeFirst();
    if (!claimed) return null;
    return {
      type: 'proxmox-inventory',
      taskId: PROXMOX_INVENTORY_TASK_PREFIX + cluster.id,
      repository: '',
      password: '',
      env: {},
      credentialFiles: [],
      proxmox: { clusterId: cluster.id, clusterSlug: cluster.slug },
    };
  }

  /** Stores the inventory a node agent read, if it belongs to this cluster. */
  async recordInventory(
    agentId: string,
    clusterId: string,
    result: { status: string; inventory?: ProxmoxInventory; error?: string },
  ): Promise<void> {
    const cluster = await this.db
      .selectFrom('proxmox_clusters')
      .select(['id', 'pve_cluster_id'])
      .where('id', '=', clusterId)
      .executeTakeFirst();
    const agents = cluster ? await this.nodeAgents(cluster.pve_cluster_id) : [];
    if (!cluster || !agents.some((a) => a.id === agentId)) {
      throw new NotFoundException('Task not found for this agent');
    }
    if (result.status === 'success' && result.inventory) {
      await this.db
        .updateTable('proxmox_clusters')
        .set({
          inventory: JSON.stringify(result.inventory),
          inventory_at: new Date(),
          inventory_error: null,
          cluster_name: result.inventory.clusterName ?? null,
        })
        .where('id', '=', clusterId)
        .execute();
      return;
    }
    await this.db
      .updateTable('proxmox_clusters')
      .set({ inventory_error: result.error ?? 'Reading the inventory failed', inventory_at: new Date() })
      .where('id', '=', clusterId)
      .execute();
  }

  // --- Run expansion ------------------------------------------------------------------

  /**
   * Turns due queued Proxmox runs into one item per guest. A run waits up to
   * EXPANSION_WAIT_MS for a fresh inventory, then uses the one it has.
   */
  async expandQueuedRuns(clusterId?: string): Promise<void> {
    let q = this.db
      .selectFrom('job_runs')
      .innerJoin('backup_jobs', 'backup_jobs.id', 'job_runs.job_id')
      .select([
        'job_runs.id as run_id',
        'job_runs.created_at',
        'job_runs.not_before',
        'job_runs.retry_of_run_id',
        'backup_jobs.id as job_id',
        'backup_jobs.proxmox_cluster_id',
        'backup_jobs.proxmox_config',
      ])
      .where('backup_jobs.source_kind', '=', 'proxmox')
      .where('job_runs.kind', '=', 'backup')
      .where('job_runs.status', '=', 'queued')
      .where((eb) =>
        eb.or([eb('job_runs.not_before', 'is', null), eb('job_runs.not_before', '<=', new Date())]),
      );
    if (clusterId) q = q.where('backup_jobs.proxmox_cluster_id', '=', clusterId);
    const runs = await q.execute();
    for (const run of runs) {
      try {
        await this.expandRun(run);
      } catch (e) {
        this.logger.error(`Expanding Proxmox run ${run.run_id} failed: ${e}`);
      }
    }
  }

  private async expandRun(run: {
    run_id: string;
    created_at: Date;
    not_before: Date | null;
    retry_of_run_id: string | null;
    job_id: string;
    proxmox_cluster_id: string | null;
    proxmox_config: unknown;
  }): Promise<void> {
    if (!run.proxmox_cluster_id) return;
    const cluster = await this.getRow(run.proxmox_cluster_id);
    const inventory = parseJson<ProxmoxInventory>(cluster.inventory);
    const fresh =
      inventory &&
      cluster.inventory_at &&
      Date.now() - new Date(cluster.inventory_at).getTime() < EXPANSION_INVENTORY_MAX_AGE_MS;
    const dueSince = new Date(run.not_before ?? run.created_at).getTime();
    const waited = Date.now() - dueSince > EXPANSION_WAIT_MS;
    if (!fresh) {
      if (!cluster.inventory_requested_at) {
        await this.db
          .updateTable('proxmox_clusters')
          .set({ inventory_requested_at: new Date() })
          .where('id', '=', cluster.id)
          .execute();
      }
      if (!waited) return;
      if (!inventory) {
        await this.failRun(run.run_id, 'The cluster has no inventory yet — is a node agent online?');
        return;
      }
    }

    // Claim the run; a concurrent poll expanding it too loses here.
    const claimed = await this.db
      .updateTable('job_runs')
      .set({
        status: 'running',
        started_at: new Date(),
        agent_id: cluster.primary_agent_id,
        proxmox_phase: 'items',
        proxmox_phase_at: new Date(),
      })
      .where('id', '=', run.run_id)
      .where('status', '=', 'queued')
      .returning('id')
      .executeTakeFirst();
    if (!claimed) return;

    const config = parseJson<ProxmoxJobConfig>(run.proxmox_config)!;
    const only = run.retry_of_run_id ? await this.failedGuests(run.retry_of_run_id) : undefined;
    const { guests, missing } = selectGuests(inventory!, config, only);
    const nodesWithAgent = new Set(
      (await this.nodeAgents(cluster.pve_cluster_id)).map((a) => a.info.node),
    );
    const known = missing.length
      ? await this.db
          .selectFrom('proxmox_job_guests')
          .select(['vmid', 'guest_type', 'name'])
          .where('job_id', '=', run.job_id)
          .where('vmid', 'in', missing)
          .execute()
      : [];
    const now = new Date();
    const rows = [
      ...guests.map((g) => {
        const noAgent = !nodesWithAgent.has(g.node);
        return {
          run_id: run.run_id,
          job_id: run.job_id,
          vmid: g.vmid,
          guest_type: g.type,
          name: g.name,
          node: g.node,
          status: (noAgent ? 'failed' : 'queued') as ProxmoxRunItemStatus,
          error: noAgent ? `No Amber agent on node ${g.node}` : null,
          finished_at: noAgent ? now : null,
        };
      }),
      ...missing.map((vmid) => {
        const k = known.find((x) => x.vmid === vmid);
        return {
          run_id: run.run_id,
          job_id: run.job_id,
          vmid,
          guest_type: (k?.guest_type ?? 'qemu') as ProxmoxGuestType,
          name: k?.name ?? '',
          node: '',
          status: 'failed' as ProxmoxRunItemStatus,
          error: 'The guest no longer exists in the cluster',
          finished_at: now,
        };
      }),
    ];
    if (rows.length) await this.db.insertInto('proxmox_run_items').values(rows).execute();
    this.logger.log(`Proxmox run ${run.run_id}: ${rows.length} guest(s)`);
    await this.settleIfDone(run.run_id);
  }

  /** Guests that failed in a run (what its retry repeats); undefined → everything. */
  private async failedGuests(runId: string): Promise<Set<number> | undefined> {
    const items = await this.db
      .selectFrom('proxmox_run_items')
      .select(['vmid', 'status'])
      .where('run_id', '=', runId)
      .execute();
    const failed = items.filter((i) => i.status === 'failed').map((i) => i.vmid);
    return failed.length ? new Set(failed) : undefined;
  }

  private async failRun(runId: string, error: string): Promise<void> {
    const row = await this.db
      .updateTable('job_runs')
      .set({ status: 'failed', finished_at: new Date(), error, proxmox_phase: 'done' })
      .where('id', '=', runId)
      .where('status', 'in', ['queued', 'running'])
      .returning('id')
      .executeTakeFirst();
    if (row) void this.retries.finalize(runId);
  }

  // --- Item dispatch --------------------------------------------------------------------

  private async claimItems(agentId: string, node: string, cluster: ProxmoxCluster): Promise<AgentTask[]> {
    const queued = await this.db
      .selectFrom('proxmox_run_items as i')
      .innerJoin('job_runs as r', 'r.id', 'i.run_id')
      .innerJoin('backup_jobs as j', 'j.id', 'i.job_id')
      .select(['i.id', 'i.job_id', 'j.proxmox_config'])
      .where('i.status', '=', 'queued')
      .where('i.node', '=', node)
      .where('r.status', '=', 'running')
      .where('j.proxmox_cluster_id', '=', cluster.id)
      .orderBy('i.created_at', 'asc')
      .orderBy('i.vmid', 'asc')
      .limit(64)
      .execute();
    if (queued.length === 0) return [];

    const jobIds = [...new Set(queued.map((q) => q.job_id))];
    const running = await this.db
      .selectFrom('proxmox_run_items')
      .select(['job_id', 'node'])
      .where('status', '=', 'running')
      .where('job_id', 'in', jobIds)
      .execute();
    const onNode = new Map<string, number>();
    const inCluster = new Map<string, number>();
    for (const r of running) {
      inCluster.set(r.job_id, (inCluster.get(r.job_id) ?? 0) + 1);
      if (r.node === node) onNode.set(r.job_id, (onNode.get(r.job_id) ?? 0) + 1);
    }
    // Until a job has backed up one guest, its repository may not exist yet:
    // parallel guests (on one or several nodes) would each run `restic init`
    // and leave a repository with mismatched config and keys. So a job without
    // a successful guest gets one guest at a time, cluster-wide.
    const proven = new Set(
      (
        await this.db
          .selectFrom('proxmox_job_guests')
          .select('job_id')
          .where('job_id', 'in', jobIds)
          .where('last_snapshot_id', 'is not', null)
          .execute()
      ).map((r) => r.job_id),
    );
    const candidates: ClaimCandidate[] = queued.map((q) => {
      const config = parseJson<ProxmoxJobConfig>(q.proxmox_config) ?? ({} as ProxmoxJobConfig);
      return {
        id: q.id,
        jobId: q.job_id,
        parallelPerNode: config.parallelPerNode ?? 1,
        maxParallel: proven.has(q.job_id) ? (config.maxParallel ?? null) : 1,
      };
    });

    const tasks: AgentTask[] = [];
    for (const id of pickClaimable(candidates, onNode, inCluster)) {
      const now = new Date();
      const item = await this.db
        .updateTable('proxmox_run_items')
        .set({ status: 'running', agent_id: agentId, started_at: now, heartbeat_at: now })
        .where('id', '=', id)
        .where('status', '=', 'queued')
        .returningAll()
        .executeTakeFirst();
      if (!item) continue;
      try {
        tasks.push(await this.backupTask(item, cluster));
      } catch (e) {
        await this.finishItem(item.id, 'failed', { error: `Preparing the task failed: ${e}` });
      }
    }
    return tasks;
  }

  private async backupTask(
    item: { id: string; job_id: string; vmid: number; guest_type: ProxmoxGuestType; name: string; node: string },
    cluster: ProxmoxCluster,
  ): Promise<AgentTask> {
    const job = await this.jobs.getRow(item.job_id);
    const config = parseJson<ProxmoxJobConfig>(job.proxmox_config) ?? ({} as ProxmoxJobConfig);
    const state = await this.db
      .selectFrom('proxmox_job_guests')
      .select(['last_snapshot_id', 'cbt'])
      .where('job_id', '=', item.job_id)
      .where('vmid', '=', item.vmid)
      .executeTakeFirst();
    const options = parseJson<ResticOptions>(job.restic_options) ?? {};
    // Retention is run once per run, after all guests (the finishing task).
    const { retention: _retention, ...guestOptions } = options;
    void _retention;
    const resolved = await this.targets.resolveForJob(job);
    const proxmox: ProxmoxTaskPayload = {
      clusterId: cluster.id,
      clusterSlug: cluster.slug,
      guest: { vmid: item.vmid, type: item.guest_type, name: item.name, node: item.node },
      vmMethod: config.vmMethod ?? 'auto',
      ctMethod: config.ctMethod ?? 'auto',
      vzdumpMode: config.vzdumpMode ?? 'snapshot',
      requireConsistent: config.requireConsistent ?? false,
      parentSnapshotId: state?.last_snapshot_id ?? undefined,
      cbt: parseJson(state?.cbt) ?? undefined,
    };
    return {
      type: 'proxmox-backup',
      taskId: item.id,
      jobId: job.id,
      jobName: job.name,
      repository: resolved.repository,
      password: resolved.password,
      env: resolved.env,
      credentialFiles: resolved.credentialFiles,
      extraArgs: resolved.extraArgs,
      paths: [],
      options: guestOptions,
      repoInitialized: await repositoryKnownInitialized(this.db, job.repository_id),
      proxmox,
    };
  }

  /** The item an agent reports on, or null when the id is no item. */
  private async itemFor(agentId: string, itemId: string) {
    if (!UUID_RE.test(itemId)) return null;
    const item = await this.db
      .selectFrom('proxmox_run_items')
      .selectAll()
      .where('id', '=', itemId)
      .executeTakeFirst();
    if (!item) return null;
    if (item.agent_id !== agentId) throw new NotFoundException('Task not found for this agent');
    return item;
  }

  /** Records a guest's outcome. Returns false when the task id is no item. */
  async recordItemResult(agentId: string, itemId: string, dto: TaskResultDto): Promise<boolean> {
    const item = await this.itemFor(agentId, itemId);
    if (!item) return false;

    if (dto.status === 'cancelled') {
      await this.db
        .updateTable('proxmox_run_items')
        .set({
          status: 'cancelled',
          finished_at: sql<Date>`coalesce(finished_at, now())`,
          error: CANCELLED_ON_AGENT_MESSAGE,
          log: dto.log ?? null,
        })
        .where('id', '=', itemId)
        .where('status', 'in', ['running', 'cancelled'])
        .execute();
      await this.settleIfDone(item.run_id);
      return true;
    }

    const g = dto.proxmoxGuest as ProxmoxGuestResult | undefined;
    if (g?.status === 'moved' && g.movedTo) {
      await this.moveItem(item, g.movedTo, dto.log);
      return true;
    }

    const status: ProxmoxRunItemStatus =
      g?.status === 'skipped'
        ? 'skipped'
        : dto.status === 'success' && (g?.status ?? 'success') === 'success'
          ? 'success'
          : 'failed';
    const error = status === 'failed' ? (g?.error ?? dto.error ?? 'The backup failed') : null;
    const result: ProxmoxGuestResult | null = g
      ? { ...g, snapshotId: g.snapshotId ?? dto.snapshotId }
      : null;
    const patch = {
      status,
      finished_at: new Date(),
      result: result ? JSON.stringify(result) : null,
      method: g?.method ?? null,
      error,
      log: dto.log ?? null,
      progress: null,
    };
    const updated =
      (await this.db
        .updateTable('proxmox_run_items')
        .set(patch)
        .where('id', '=', itemId)
        // A cancel on the server wins over a late result.
        .where('status', '=', 'running')
        .returning('id')
        .executeTakeFirst()) ??
      // A guest the server gave up on (lease expired) still records its real
      // outcome, so its snapshot becomes the next run's parent.
      (await this.db
        .updateTable('proxmox_run_items')
        .set(patch)
        .where('id', '=', itemId)
        .where('status', '=', 'failed')
        .where('error', 'in', LEASE_EXPIRED_MESSAGES)
        .returning('id')
        .executeTakeFirst());
    if (updated && status !== 'skipped') {
      await this.recordGuestState(item, status, result, dto);
    }
    await this.settleIfDone(item.run_id);
    return true;
  }

  private async moveItem(
    item: { id: string; run_id: string; moves: number; node: string },
    movedTo: string,
    log: string | undefined,
  ): Promise<void> {
    if (item.moves >= MAX_ITEM_MOVES) {
      await this.finishItem(item.id, 'failed', {
        error: `The guest kept moving between nodes (last seen on ${movedTo})`,
        log,
      });
      await this.settleIfDone(item.run_id);
      return;
    }
    const cluster = await this.db
      .selectFrom('proxmox_run_items as i')
      .innerJoin('backup_jobs as j', 'j.id', 'i.job_id')
      .innerJoin('proxmox_clusters as c', 'c.id', 'j.proxmox_cluster_id')
      .select('c.pve_cluster_id')
      .where('i.id', '=', item.id)
      .executeTakeFirst();
    const agents = cluster ? await this.nodeAgents(cluster.pve_cluster_id) : [];
    if (!agents.some((a) => a.info.node === movedTo)) {
      await this.finishItem(item.id, 'failed', {
        error: `The guest moved to node ${movedTo}, which has no Amber agent`,
        log,
      });
      await this.settleIfDone(item.run_id);
      return;
    }
    await this.db
      .updateTable('proxmox_run_items')
      .set({
        status: 'queued',
        node: movedTo,
        agent_id: null,
        started_at: null,
        heartbeat_at: null,
        // The wait for the new node's agent starts now.
        queued_at: new Date(),
        progress: null,
        moves: item.moves + 1,
      })
      .where('id', '=', item.id)
      .where('status', '=', 'running')
      .execute();
    this.logger.log(`Item ${item.id}: guest moved from ${item.node} to ${movedTo}`);
  }

  private async finishItem(
    itemId: string,
    status: ProxmoxRunItemStatus,
    fields: { error?: string | null; log?: string | null },
  ): Promise<void> {
    await this.db
      .updateTable('proxmox_run_items')
      .set({
        status,
        finished_at: new Date(),
        error: fields.error ?? null,
        ...(fields.log !== undefined ? { log: fields.log } : {}),
      })
      .where('id', '=', itemId)
      .where('status', 'in', ['queued', 'running'])
      .execute();
  }

  /** Keeps a guest's parent snapshot and change tracking for the next run. */
  private async recordGuestState(
    item: { job_id: string; vmid: number; guest_type: ProxmoxGuestType; name: string },
    status: ProxmoxRunItemStatus,
    result: ProxmoxGuestResult | null,
    dto: TaskResultDto,
  ): Promise<void> {
    const now = new Date();
    const snapshotId = status === 'success' ? (result?.snapshotId ?? dto.snapshotId ?? null) : undefined;
    const cbt = result?.nextCbt !== undefined ? (result.nextCbt ? JSON.stringify(result.nextCbt) : null) : undefined;
    const lastResult = JSON.stringify(
      result ?? { vmid: item.vmid, type: item.guest_type, name: item.name, node: '', status: 'failed', error: dto.error },
    );
    const values = {
      job_id: item.job_id,
      vmid: item.vmid,
      guest_type: item.guest_type,
      name: result?.name || item.name,
      last_status: status,
      last_result: lastResult,
      last_finished_at: now,
      updated_at: now,
      ...(snapshotId !== undefined ? { last_snapshot_id: snapshotId } : {}),
      ...(cbt !== undefined ? { cbt } : {}),
    };
    const { job_id: _j, vmid: _v, ...update } = values;
    void _j;
    void _v;
    await this.db
      .insertInto('proxmox_job_guests')
      .values(values)
      .onConflict((oc) => oc.columns(['job_id', 'vmid']).doUpdateSet(update))
      .execute();
  }

  /** Live progress of a guest. Returns false when the task id is no item. */
  async recordItemProgress(
    agentId: string,
    itemId: string,
    stats: Record<string, unknown>,
  ): Promise<boolean> {
    const item = await this.itemFor(agentId, itemId);
    if (!item) return false;
    await this.db
      .updateTable('proxmox_run_items')
      .set({ progress: JSON.stringify(stats), heartbeat_at: new Date() })
      .where('id', '=', itemId)
      .where('status', '=', 'running')
      .execute();
    const items = await this.db
      .selectFrom('proxmox_run_items')
      .select(['status', 'progress', 'result'])
      .where('run_id', '=', item.run_id)
      .execute();
    const progress = aggregateProgress(
      items.map((i) => ({
        status: i.status,
        progress: parseJson<Record<string, unknown>>(i.progress),
        result: parseJson<Record<string, unknown>>(i.result),
      })),
    );
    await this.db
      .updateTable('job_runs')
      .set({ stats: JSON.stringify(progress) })
      .where('id', '=', item.run_id)
      .where('status', '=', 'running')
      .where('proxmox_phase', '=', 'items')
      .execute();
    return true;
  }

  /** Cancel state of an item or finishing task; null when the id is neither. */
  async taskState(agentId: string, taskId: string): Promise<{ cancelled: boolean } | null> {
    if (taskId.startsWith(PROXMOX_RETENTION_TASK_PREFIX)) {
      const runId = taskId.slice(PROXMOX_RETENTION_TASK_PREFIX.length);
      if (!UUID_RE.test(runId)) throw new NotFoundException('Task not found for this agent');
      // Asked every few seconds while the task runs: renews its lease.
      await this.db
        .updateTable('job_runs')
        .set({ heartbeat_at: new Date() })
        .where('id', '=', runId)
        .where('agent_id', '=', agentId)
        .where('proxmox_phase', '=', 'retention_running')
        .where('status', '=', 'running')
        .execute();
      const run = await this.db
        .selectFrom('job_runs')
        .select(['status', 'agent_id'])
        .where('id', '=', runId)
        .executeTakeFirst();
      if (!run) return { cancelled: true };
      if (run.agent_id !== agentId) throw new NotFoundException('Task not found for this agent');
      return { cancelled: run.status === 'cancelled' };
    }
    if (!UUID_RE.test(taskId)) return null;
    const item = await this.db
      .selectFrom('proxmox_run_items as i')
      .leftJoin('job_runs as r', 'r.id', 'i.run_id')
      .select(['i.status', 'i.agent_id', 'r.status as run_status'])
      .where('i.id', '=', taskId)
      .executeTakeFirst();
    if (!item) return null;
    if (item.agent_id !== agentId) {
      // Moved to another node meanwhile: this agent's copy is obsolete.
      return { cancelled: true };
    }
    const cancelled = item.status === 'cancelled' || item.run_status === 'cancelled';
    if (!cancelled && item.status === 'running') {
      // Asked every few seconds while the guest is backed up: renews its lease.
      await this.db
        .updateTable('proxmox_run_items')
        .set({ heartbeat_at: new Date() })
        .where('id', '=', taskId)
        .where('agent_id', '=', agentId)
        .where('status', '=', 'running')
        .execute();
    }
    return { cancelled };
  }

  // --- Settling & the finishing task ---------------------------------------------------

  private async settledItems(runId: string): Promise<SettledItem[] | null> {
    const items = await this.db
      .selectFrom('proxmox_run_items')
      .select(['vmid', 'name', 'status', 'result', 'error'])
      .where('run_id', '=', runId)
      .orderBy('vmid', 'asc')
      .execute();
    if (items.some((i) => isOpen(i.status))) return null;
    return items.map((i) => ({
      vmid: i.vmid,
      name: i.name,
      status: i.status,
      result: parseJson<ProxmoxGuestResult>(i.result),
      error: i.error,
    }));
  }

  /**
   * Once every item of a run is terminal, the run moves to its finishing task
   * (forget/prune/repo figures on a node agent), once.
   */
  async settleIfDone(runId: string): Promise<void> {
    const items = await this.settledItems(runId);
    if (!items) return;
    const summary = summarize(items);
    const stats = JSON.stringify({
      proxmoxGuests: summary,
      dataAdded: summary.dataAdded,
      percentDone: 1,
      filesDone: items.length,
      totalFiles: items.length,
    });
    const moved = await this.db
      .updateTable('job_runs')
      .set({ stats, proxmox_phase: 'retention', proxmox_phase_at: new Date() })
      .where('id', '=', runId)
      .where('status', '=', 'running')
      .where('proxmox_phase', '=', 'items')
      .returning('id')
      .executeTakeFirst();
    if (!moved) {
      // A cancelled run still gets its per-guest summary.
      await this.db
        .updateTable('job_runs')
        .set({ stats, proxmox_phase: 'done' })
        .where('id', '=', runId)
        .where('status', '=', 'cancelled')
        .execute();
      return;
    }
    // Nothing was backed up: there is nothing to forget either.
    if (summary.success === 0) await this.finishRun(runId, null);
  }

  private async claimRetention(agentId: string, cluster: ProxmoxCluster): Promise<AgentTask[]> {
    const runs = await this.db
      .selectFrom('job_runs as r')
      .innerJoin('backup_jobs as j', 'j.id', 'r.job_id')
      .select(['r.id'])
      .where('r.proxmox_phase', '=', 'retention')
      .where('r.status', '=', 'running')
      .where('j.proxmox_cluster_id', '=', cluster.id)
      .execute();
    const tasks: AgentTask[] = [];
    for (const run of runs) {
      const now = new Date();
      const claimed = await this.db
        .updateTable('job_runs')
        .set({
          proxmox_phase: 'retention_running',
          proxmox_phase_at: now,
          heartbeat_at: now,
          agent_id: agentId,
        })
        .where('id', '=', run.id)
        .where('proxmox_phase', '=', 'retention')
        .returning(['id', 'job_id'])
        .executeTakeFirst();
      if (!claimed) continue;
      try {
        const job = await this.jobs.getRow(claimed.job_id);
        const options = parseJson<ResticOptions>(job.restic_options) ?? {};
        const resolved = await this.targets.resolveForJob(job);
        tasks.push({
          type: 'proxmox-retention',
          taskId: PROXMOX_RETENTION_TASK_PREFIX + run.id,
          jobId: job.id,
          jobName: job.name,
          repository: resolved.repository,
          password: resolved.password,
          env: resolved.env,
          credentialFiles: resolved.credentialFiles,
          extraArgs: resolved.extraArgs,
          options: options.retention ? { retention: options.retention } : {},
          proxmox: { clusterId: cluster.id, clusterSlug: cluster.slug },
        });
      } catch (e) {
        // The guests are backed up; the run finishes without its retention.
        this.logger.error(`Preparing the finishing task of run ${run.id} failed: ${e}`);
        await this.finishRun(run.id, `Retention skipped: preparing the task failed: ${errorText(e)}`).catch(
          (err) => this.logger.error(`Could not finish run ${run.id}: ${err}`),
        );
      }
    }
    return tasks;
  }

  /** Records the finishing task (forget, prune, repository figures), then ends the run. */
  async recordRetention(agentId: string, runId: string, dto: TaskResultDto): Promise<void> {
    const run = UUID_RE.test(runId)
      ? await this.db
          .selectFrom('job_runs')
          .innerJoin('backup_jobs', 'backup_jobs.id', 'job_runs.job_id')
          .select([
            'job_runs.id',
            'job_runs.job_id',
            'job_runs.trigger',
            'job_runs.agent_id',
            'job_runs.proxmox_phase',
            'backup_jobs.repository_id',
          ])
          .where('job_runs.id', '=', runId)
          .executeTakeFirst()
      : undefined;
    if (!run || run.agent_id !== agentId) {
      throw new NotFoundException('Task not found for this agent');
    }
    // Already finished (a repeated result, or the run was given up on):
    // acknowledged without recording the prune or the figures twice.
    if (run.proxmox_phase !== 'retention_running') return;
    if (dto.forgetResult) {
      await this.db
        .updateTable('job_runs')
        .set({ forget_result: JSON.stringify(dto.forgetResult) })
        .where('id', '=', runId)
        .execute();
    }
    const statsReported = dto.repoStats != null || dto.repoStatsError != null;
    if (dto.repoStats) {
      await this.repositories.recordStats(run.repository_id, {
        size_bytes: dto.repoStats.sizeBytes,
        snapshot_count: dto.repoStats.snapshotCount,
      });
    } else if (dto.repoStatsError) {
      await this.repositories.recordStats(run.repository_id, { error: dto.repoStatsError });
    } else if (dto.status === 'success') {
      this.repositories.refreshStatsInBackground(run.repository_id);
    }
    if (dto.prune) {
      await this.pruneRunner.record({
        jobId: run.job_id,
        repositoryId: run.repository_id,
        trigger: run.trigger,
        parentRunId: runId,
        agentId,
        status: dto.prune.status,
        startedAt: new Date(dto.prune.startedAt),
        finishedAt: new Date(dto.prune.finishedAt),
        error: dto.prune.error ?? null,
        log: dto.prune.log ?? null,
        statsReported,
      });
    }
    if (dto.status === 'cancelled') {
      await this.db
        .updateTable('job_runs')
        .set({
          status: 'cancelled',
          finished_at: sql<Date>`coalesce(finished_at, now())`,
          error: CANCELLED_ON_AGENT_MESSAGE,
          proxmox_phase: 'done',
        })
        .where('id', '=', runId)
        .where('status', 'in', ['running', 'cancelled'])
        .execute();
      return;
    }
    const note =
      dto.status === 'failed'
        ? `Retention failed: ${dto.error ?? 'unknown error'}`
        : null;
    await this.finishRun(runId, [note, dto.log].filter(Boolean).join('\n') || null);
  }

  /** Writes a settled run's final status from its items and settles it (retry/notify). */
  private async finishRun(runId: string, retentionLog: string | null): Promise<void> {
    const items = (await this.settledItems(runId)) ?? [];
    const outcome = runOutcome(items);
    const log = [runLog(items), retentionLog].filter(Boolean).join('\n\n');
    const done = await this.db
      .updateTable('job_runs')
      .set({
        status: outcome.status,
        finished_at: new Date(),
        error: outcome.error,
        log: log || null,
        proxmox_phase: 'done',
        proxmox_phase_at: new Date(),
      })
      .where('id', '=', runId)
      .where('status', '=', 'running')
      .returning('id')
      .executeTakeFirst();
    if (done) void this.retries.finalize(runId);
  }

  // --- Sweeps ------------------------------------------------------------------------------

  /** Expands due runs, fails stuck items and finishes runs nobody finishes. */
  @Interval(15_000)
  async sweep(): Promise<void> {
    try {
      await this.expandQueuedRuns();
      await this.sweepItems();
      await this.sweepRetention();
    } catch (e) {
      this.logger.warn(`Proxmox sweep failed: ${e}`);
    }
  }

  private async sweepItems(): Promise<void> {
    const runs = new Set<string>();
    // Items of runs cancelled (or finished) elsewhere.
    const orphaned = await this.db
      .updateTable('proxmox_run_items')
      .set({ status: 'cancelled', finished_at: new Date() })
      .where('status', 'in', ['queued', 'running'])
      .where('run_id', 'in', (eb) =>
        eb.selectFrom('job_runs').select('id').where('status', 'not in', ['queued', 'running']),
      )
      .returning('run_id')
      .execute();
    for (const r of orphaned) runs.add(r.run_id);

    for (const runId of await this.failUnclaimedItems()) runs.add(runId);

    // Guests whose agent stopped reporting on them (restart, crash, lost poll answer).
    const timeouts = configuredLeaseTimeouts();
    if (timeouts) {
      const now = new Date();
      const lost = await this.db
        .updateTable('proxmox_run_items')
        .from('agents')
        .set({ status: 'failed', finished_at: now, error: AGENT_STOPPED_REPORTING_MESSAGE, progress: null })
        .whereRef('agents.id', '=', 'proxmox_run_items.agent_id')
        .where('proxmox_run_items.status', '=', 'running')
        .where(leaseExpiredSql('proxmox_run_items', 'agents', timeouts, now, this.startedAt))
        .returning(['proxmox_run_items.id', 'proxmox_run_items.run_id'])
        .execute();
      for (const item of lost) {
        this.logger.warn(`Item ${item.id}: the agent stopped reporting on it`);
        runs.add(item.run_id);
      }
    }
    for (const runId of runs) await this.settleIfDone(runId);
  }

  /**
   * Fails queued guests nobody can pick up: their node has no agent, or its
   * agent is offline and has not been seen for the queue timeout (at least
   * two of its poll intervals plus a minute) since the guest became
   * claimable. Guests waiting for a free slot behind others on a node whose
   * agent is online wait as long as it takes — the job's time limit is about
   * one backup, not about the queue. Returns the runs touched.
   */
  private async failUnclaimedItems(): Promise<string[]> {
    const timeout = loadConfig().runQueueTimeoutSeconds;
    if (timeout <= 0) return [];
    const queued = await this.db
      .selectFrom('proxmox_run_items as i')
      .innerJoin('backup_jobs as j', 'j.id', 'i.job_id')
      .innerJoin('proxmox_clusters as c', 'c.id', 'j.proxmox_cluster_id')
      .select(['i.id', 'i.run_id', 'i.node', 'i.queued_at', 'c.pve_cluster_id'])
      .where('i.status', '=', 'queued')
      .execute();
    const agentsOf = new Map<string, NodeAgent[]>();
    const runs: string[] = [];
    for (const item of queued) {
      let agents = agentsOf.get(item.pve_cluster_id);
      if (!agents) {
        agents = await this.nodeAgents(item.pve_cluster_id);
        agentsOf.set(item.pve_cluster_id, agents);
      }
      const agent = agents.find((a) => a.info.node === item.node);
      if (agent?.status === 'online') continue;
      const since = Math.max(
        new Date(item.queued_at).getTime(),
        agent?.last_seen_at ? new Date(agent.last_seen_at).getTime() : 0,
      );
      const wait = agentWaitSeconds(timeout, agent?.poll_interval_seconds);
      if (Date.now() - since < wait * 1000) continue;
      const minutes = Math.round(wait / 60);
      await this.finishItem(item.id, 'failed', {
        error: agent
          ? `Not picked up — the agent on node ${item.node} has been offline for over ${minutes} min`
          : `Not picked up within ${minutes} min — no Amber agent runs on node ${item.node}`,
      });
      runs.push(item.run_id);
    }
    return runs;
  }

  /** Renews the guests and finishing tasks a poll lists as still held by the agent. */
  async renewAgentTasks(agentId: string, taskIds: string[], now: Date): Promise<void> {
    const items = runIds(taskIds);
    if (items.length) {
      await this.db
        .updateTable('proxmox_run_items')
        .set({ heartbeat_at: now })
        .where('agent_id', '=', agentId)
        .where('status', '=', 'running')
        .where('id', 'in', items)
        .execute();
    }
    const retention = runIds(taskIds, PROXMOX_RETENTION_TASK_PREFIX);
    if (retention.length) {
      await this.db
        .updateTable('job_runs')
        .set({ heartbeat_at: now })
        .where('agent_id', '=', agentId)
        .where('status', '=', 'running')
        .where('proxmox_phase', '=', 'retention_running')
        .where('id', 'in', retention)
        .execute();
    }
  }

  /**
   * Fails the guests and finishes the finishing tasks this agent claimed
   * before its previous poll and no longer lists (it restarted, or the poll
   * answer was lost).
   */
  async reconcileAgentTasks(agentId: string, taskIds: string[], previousPollAt: Date): Promise<void> {
    const items = runIds(taskIds);
    let lostItems = this.db
      .updateTable('proxmox_run_items')
      .set({ status: 'failed', finished_at: new Date(), error: AGENT_LOST_TASK_MESSAGE, progress: null })
      .where('agent_id', '=', agentId)
      .where('status', '=', 'running')
      .where('started_at', '<', previousPollAt);
    if (items.length) lostItems = lostItems.where('id', 'not in', items);
    const lost = await lostItems.returning('run_id').execute();
    for (const runId of new Set(lost.map((i) => i.run_id))) await this.settleIfDone(runId);

    const retention = runIds(taskIds, PROXMOX_RETENTION_TASK_PREFIX);
    let lostRetention = this.db
      .selectFrom('job_runs')
      .select('id')
      .where('agent_id', '=', agentId)
      .where('status', '=', 'running')
      .where('proxmox_phase', '=', 'retention_running')
      .where('proxmox_phase_at', '<', previousPollAt);
    if (retention.length) lostRetention = lostRetention.where('id', 'not in', retention);
    for (const run of await lostRetention.execute()) {
      await this.finishRun(run.id, `Retention result never arrived: ${AGENT_LOST_TASK_MESSAGE}`);
    }
  }

  private async sweepRetention(): Promise<void> {
    const timeouts = configuredLeaseTimeouts();
    if (timeouts) {
      const lost = await this.db
        .selectFrom('job_runs')
        .innerJoin('agents', 'agents.id', 'job_runs.agent_id')
        .select('job_runs.id')
        .where('job_runs.status', '=', 'running')
        .where('job_runs.proxmox_phase', '=', 'retention_running')
        .where(
          leaseExpiredSql(
            'job_runs',
            'agents',
            timeouts,
            new Date(),
            // A finishing task's started_at is the run's; its lease starts at its claim.
            this.startedAt,
          ),
        )
        .execute();
      for (const run of lost) {
        this.logger.warn(`Run ${run.id}: the agent stopped reporting on its finishing task`);
        await this.finishRun(run.id, `Retention result never arrived: ${AGENT_STOPPED_REPORTING_MESSAGE}`);
      }
    }
    const now = Date.now();
    const stuck = await this.db
      .selectFrom('job_runs')
      .select(['id', 'proxmox_phase', 'proxmox_phase_at'])
      .where('status', '=', 'running')
      .where('proxmox_phase', 'in', ['retention', 'retention_running'])
      .execute();
    for (const run of stuck) {
      const since = now - new Date(run.proxmox_phase_at ?? 0).getTime();
      const limit = run.proxmox_phase === 'retention' ? RETENTION_UNCLAIMED_MS : RETENTION_RUNNING_MS;
      if (since < limit) continue;
      this.logger.warn(`Run ${run.id}: finishing task ${run.proxmox_phase} timed out, finishing without it`);
      await this.finishRun(
        run.id,
        run.proxmox_phase === 'retention'
          ? 'Retention skipped: no node agent picked up the finishing task.'
          : 'Retention result never arrived; the run was finished without it.',
      );
    }
  }

  // --- Restore -------------------------------------------------------------------------------

  /** The agent of the node a restore targets. */
  async restoreAgent(spec: ProxmoxRestoreSpec): Promise<string> {
    const cluster = await this.db
      .selectFrom('proxmox_clusters')
      .select(['id', 'pve_cluster_id'])
      .where('id', '=', spec.clusterId)
      .executeTakeFirst();
    if (!cluster) throw new BadRequestException('Unknown Proxmox cluster');
    const agent = (await this.nodeAgents(cluster.pve_cluster_id)).find(
      (a) => a.info.node === spec.targetNode,
    );
    if (!agent) throw new BadRequestException(`No Amber agent runs on node ${spec.targetNode}`);
    return agent.id;
  }

  async restorePayload(spec: ProxmoxRestoreSpec): Promise<ProxmoxTaskPayload> {
    const cluster = await this.getRow(spec.clusterId);
    return { clusterId: cluster.id, clusterSlug: cluster.slug, restore: spec };
  }
}

/** Nodes of the inventory (plus nodes only known from agents) with their agents. */
export function nodeViews(inventory: ProxmoxInventory | null, agents: NodeAgent[]): ProxmoxNodeView[] {
  const names = new Map<string, boolean>();
  for (const n of inventory?.nodes ?? []) names.set(n.name, n.online);
  for (const a of agents) if (!names.has(a.info.node)) names.set(a.info.node, false);
  return [...names.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, online]) => {
      const agent = agents.find((a) => a.info.node === name);
      return {
        name,
        online,
        agentId: agent?.id ?? null,
        agentName: agent?.name ?? null,
        agentStatus: agent?.status ?? null,
      };
    });
}

/** The message of a thrown value. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null;
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}
