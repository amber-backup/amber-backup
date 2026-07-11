import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { generateKeyPairSync } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import * as path from 'path';
import { Interval } from '@nestjs/schedule';
import { Db, KYSELY } from '../database/database.module';
import { CryptoService } from '../crypto/crypto.service';
import { TargetsService } from '../targets/targets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { loadConfig } from '../config/configuration';
import {
  Agent,
  GlobalEnrollmentValue,
  ResticOptions,
  RestoreOptions,
  RestoreDestination,
} from '../database/database.types';
import { RequestAgent } from '../common/auth/request-user';
import {
  CreateEnrollmentTokenDto,
  EnrollDto,
  PollDto,
  TaskResultDto,
  UpdateAgentDto,
} from './dto/agent.dto';

/** Placeholder swapped for the operator-chosen agent name in rollout commands. */
const NAME_PLACEHOLDER = '__AGENT_NAME__';

export interface AgentTask {
  type: 'backup' | 'restore';
  taskId: string;
  repository: string;
  password: string;
  env: Record<string, string>;
  credentialFiles: { envVar: string; filename: string; content: string }[];
  // backup
  paths?: string[];
  options?: ResticOptions;
  // restore
  snapshotId?: string;
  targetPath?: string;
  includedPaths?: string[] | null;
  restoreOptions?: RestoreOptions;
}

export type PublicAgent = Omit<Agent, 'agent_key_hash' | 'server_privkey'>;

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly targets: TargetsService,
    private readonly notifications: NotificationsService,
  ) {}

  private toPublic(a: Agent): PublicAgent {
    const { agent_key_hash, server_privkey, ...rest } = a;
    void agent_key_hash;
    void server_privkey;
    return rest;
  }

  // --- Admin: enrollment tokens & agent management -------------------------

  async createEnrollmentToken(userId: string, dto: CreateEnrollmentTokenDto) {
    const token = this.crypto.generateToken(24);
    const expiresAt = new Date(
      Date.now() + (dto.expiresInMinutes ?? 60) * 60_000,
    );
    await this.db
      .insertInto('enrollment_tokens')
      .values({
        token_hash: this.crypto.hashToken(token),
        intended_agent_name: dto.intendedAgentName ?? null,
        expires_at: expiresAt,
        created_by: userId,
      })
      .execute();

    const baseUrl = loadConfig().publicBaseUrl.replace(/\/$/, '');
    const method = dto.deployMethod ?? 'binary';
    return {
      token,
      expiresAt,
      deployMethod: method,
      installCommand: this.installCommand(
        method,
        baseUrl,
        token,
        dto.intendedAgentName,
      ),
    };
  }

  private installCommand(
    method: 'binary' | 'docker' | 'docker-compose',
    baseUrl: string,
    token: string,
    name?: string,
  ): string {
    const image = 'devpatf/amber-backup-agent:latest';
    // The agent reports AMBER_NAME as its own name on enrollment.
    const nameVal = name ?? '';
    if (method === 'docker') {
      return (
        `docker run -d --restart unless-stopped ` +
        `-e AMBER_URL=${baseUrl} -e AMBER_TOKEN=${token} -e AMBER_NAME="${nameVal}" ` +
        `-v amber-agent:/var/lib/amber-agent ${image}`
      );
    }
    if (method === 'docker-compose') {
      return [
        'services:',
        '  amber-agent:',
        `    image: ${image}`,
        '    restart: unless-stopped',
        '    environment:',
        `      AMBER_URL: ${baseUrl}`,
        `      AMBER_TOKEN: ${token}`,
        `      AMBER_NAME: "${nameVal}"`,
        '    volumes:',
        '      - amber-agent:/var/lib/amber-agent',
        'volumes:',
        '  amber-agent:',
      ].join('\n');
    }
    return `curl -sSL ${baseUrl}/api/agents/install.sh | AMBER_URL=${baseUrl} AMBER_TOKEN=${token} AMBER_NAME="${nameVal}" sh`;
  }

  // --- Global (self-registration) enrollment token -------------------------

  private static readonly GLOBAL_KEY = 'global_enrollment';

  /** Reads the stored global-enrollment config, decrypting the token. */
  private async readGlobal(): Promise<{ enabled: boolean; token: string | null }> {
    const row = await this.db
      .selectFrom('app_settings')
      .select('value')
      .where('key', '=', AgentsService.GLOBAL_KEY)
      .executeTakeFirst();
    if (!row || row.value == null) return { enabled: false, token: null };
    const v = (
      typeof row.value === 'string' ? JSON.parse(row.value) : row.value
    ) as GlobalEnrollmentValue;
    const token =
      v.ciphertext && v.nonce
        ? this.crypto.decrypt({ ciphertext: v.ciphertext, nonce: v.nonce })
        : null;
    return { enabled: !!v.enabled, token };
  }

  private async writeGlobal(enabled: boolean, token: string | null): Promise<void> {
    const enc = token ? this.crypto.encrypt(token) : null;
    const value: GlobalEnrollmentValue = {
      enabled,
      ciphertext: enc?.ciphertext ?? null,
      nonce: enc?.nonce ?? null,
    };
    await this.db
      .insertInto('app_settings')
      .values({
        key: AgentsService.GLOBAL_KEY,
        value: JSON.stringify(value),
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({
          value: JSON.stringify(value),
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  /** Admin: current global enrollment state (token shown only when enabled). */
  async getGlobalEnrollment(): Promise<{ enabled: boolean; token: string | null }> {
    const g = await this.readGlobal();
    return { enabled: g.enabled, token: g.enabled ? g.token : null };
  }

  /** Admin: enable/disable self-registration, minting a token on first enable. */
  async setGlobalEnrollment(
    enabled: boolean,
  ): Promise<{ enabled: boolean; token: string | null }> {
    const g = await this.readGlobal();
    const token = enabled ? g.token ?? this.crypto.generateToken(24) : g.token;
    await this.writeGlobal(enabled, token);
    return { enabled, token: enabled ? token : null };
  }

  /** Admin: rotate the global token (invalidates it for future rollouts). */
  async rotateGlobalToken(): Promise<{ enabled: boolean; token: string }> {
    const token = this.crypto.generateToken(24);
    await this.writeGlobal(true, token);
    return { enabled: true, token };
  }

  /** Per-method rollout commands using the global token and a name placeholder. */
  async globalEnrollmentInfo(): Promise<{
    enabled: boolean;
    token: string | null;
    commands: Record<string, string> | null;
    namePlaceholder: string;
  }> {
    const g = await this.readGlobal();
    if (!g.enabled || !g.token) {
      return { enabled: false, token: null, commands: null, namePlaceholder: NAME_PLACEHOLDER };
    }
    const baseUrl = loadConfig().publicBaseUrl.replace(/\/$/, '');
    const commands: Record<string, string> = {
      binary: this.installCommand('binary', baseUrl, g.token, NAME_PLACEHOLDER),
      docker: this.installCommand('docker', baseUrl, g.token, NAME_PLACEHOLDER),
      'docker-compose': this.installCommand('docker-compose', baseUrl, g.token, NAME_PLACEHOLDER),
    };
    return { enabled: true, token: g.token, commands, namePlaceholder: NAME_PLACEHOLDER };
  }

  /** Whether the presented token is the active global enrollment token. */
  private async matchesGlobalToken(presented: string): Promise<boolean> {
    const g = await this.readGlobal();
    if (!g.enabled || !g.token) return false;
    return this.crypto.safeCompareHash(
      this.crypto.hashToken(presented),
      this.crypto.hashToken(g.token),
    );
  }

  installScript(): string {
    const baseUrl = loadConfig().publicBaseUrl.replace(/\/$/, '');
    return `#!/bin/sh
# Amber Backup agent installer
set -e
AMBER_URL="\${AMBER_URL:-${baseUrl}}"
: "\${AMBER_TOKEN:?AMBER_TOKEN is required}"
AMBER_NAME="\${AMBER_NAME:-}"
INSTALL_DIR="\${INSTALL_DIR:-/opt/amber-agent}"
ARCH="$(uname -m)"
case "$ARCH" in x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; esac

echo "Installing Amber agent to $INSTALL_DIR (arch=$ARCH)"
mkdir -p "$INSTALL_DIR"
# -f makes curl fail (non-zero) on HTTP errors instead of writing the error body
# into the binary — otherwise systemd would exec a text file (status 203/EXEC).
if ! curl -fsSL "$AMBER_URL/api/agents/binary/linux-$ARCH" -o "$INSTALL_DIR/amber-agent"; then
  echo "Failed to download agent binary for linux-$ARCH from $AMBER_URL" >&2
  exit 1
fi
chmod +x "$INSTALL_DIR/amber-agent"

cat > /etc/systemd/system/amber-agent.service <<EOF
[Unit]
Description=Amber Backup Agent
After=network-online.target

[Service]
Environment=AMBER_URL=$AMBER_URL
Environment=AMBER_TOKEN=$AMBER_TOKEN
Environment=AMBER_NAME=$AMBER_NAME
Environment=INSTALL_DIR=$INSTALL_DIR
ExecStart=$INSTALL_DIR/amber-agent
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now amber-agent
echo "Amber agent installed and started."
`;
  }

  /** Streams the compiled agent binary for the given os-arch target. */
  binary(target: string): StreamableFile {
    const allowed = ['linux-amd64', 'linux-arm64'];
    if (!allowed.includes(target)) {
      throw new NotFoundException(`Unsupported agent target: ${target}`);
    }
    const dir = path.resolve(loadConfig().agentBinaryDir);
    const file = path.join(dir, `amber-agent-${target}`);
    if (!existsSync(file)) {
      throw new NotFoundException(
        `Agent binary for ${target} is not available on this server`,
      );
    }
    return new StreamableFile(createReadStream(file), {
      type: 'application/octet-stream',
      disposition: 'attachment; filename="amber-agent"',
    });
  }

  async list(): Promise<PublicAgent[]> {
    const rows = await this.db
      .selectFrom('agents')
      .selectAll()
      .orderBy('name', 'asc')
      .execute();
    return rows.map((a) => this.toPublic(a));
  }

  async get(id: string): Promise<PublicAgent> {
    const a = await this.db
      .selectFrom('agents')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!a) throw new NotFoundException('Agent not found');
    return this.toPublic(a);
  }

  async update(id: string, dto: UpdateAgentDto): Promise<PublicAgent> {
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.pollIntervalSeconds !== undefined)
      patch.poll_interval_seconds = dto.pollIntervalSeconds;
    const a = await this.db
      .updateTable('agents')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!a) throw new NotFoundException('Agent not found');
    return this.toPublic(a);
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteFrom('agents').where('id', '=', id).execute();
  }

  // --- Agent: enrollment ----------------------------------------------------

  async enroll(dto: EnrollDto) {
    // A rollout token — whether the reusable global token or a one-time token —
    // is only ever exchanged here for the agent's own long-lived credential.
    const viaGlobal = await this.matchesGlobalToken(dto.token);

    let oneTimeTokenId: string | null = null;
    let name = dto.agentName?.trim();

    if (!viaGlobal) {
      const token = await this.db
        .selectFrom('enrollment_tokens')
        .selectAll()
        .where('token_hash', '=', this.crypto.hashToken(dto.token))
        .executeTakeFirst();

      if (!token) throw new ForbiddenException('Invalid enrollment token');
      if (token.used_at) throw new ForbiddenException('Token already used');
      if (new Date(token.expires_at) < new Date()) {
        throw new ForbiddenException('Enrollment token expired');
      }
      oneTimeTokenId = token.id;
      // A one-time token may pin the agent name; otherwise the agent names itself.
      name = token.intended_agent_name?.trim() || name;
    }

    if (!name) {
      throw new BadRequestException('Agent name is required for enrollment');
    }

    // Server keypair for signing task payloads (integrity verification).
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const agentKey = this.crypto.generateToken(32);
    const agent = await this.db
      .insertInto('agents')
      .values({
        name,
        hostname: dto.hostname ?? null,
        os: dto.os ?? null,
        deploy_method: 'binary',
        status: 'enrolled',
        agent_key_hash: this.crypto.hashToken(agentKey),
        agent_pubkey: dto.pubkey ?? null,
        server_privkey: privateKey,
        agent_version: dto.agentVersion ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // One-time tokens are consumed; the global token stays valid for the fleet.
    if (oneTimeTokenId) {
      await this.db
        .updateTable('enrollment_tokens')
        .set({ used_at: new Date() })
        .where('id', '=', oneTimeTokenId)
        .execute();
    }

    this.logger.log(
      `Agent enrolled: ${agent.name} (${agent.id})${viaGlobal ? ' [self-registered]' : ''}`,
    );
    return {
      agentId: agent.id,
      agentKey,
      serverPubkey: publicKey,
      pollIntervalSeconds: agent.poll_interval_seconds,
    };
  }

  // --- Agent: poll & task dispatch -----------------------------------------

  async poll(
    agent: RequestAgent,
    dto: PollDto,
  ): Promise<{ tasks: AgentTask[]; pollIntervalSeconds: number }> {
    const row = await this.db
      .updateTable('agents')
      .set({
        last_seen_at: new Date(),
        status: 'online',
        restic_version: dto.resticVersion ?? null,
        agent_version: dto.agentVersion ?? null,
        updated_at: new Date(),
      })
      .where('id', '=', agent.id)
      .returning('poll_interval_seconds')
      .executeTakeFirst();

    const tasks: AgentTask[] = [];
    tasks.push(...(await this.claimBackupTasks(agent.id)));
    tasks.push(...(await this.claimRestoreTasks(agent.id)));

    return {
      tasks,
      pollIntervalSeconds: row?.poll_interval_seconds ?? 30,
    };
  }

  private async claimBackupTasks(agentId: string): Promise<AgentTask[]> {
    const runs = await this.db
      .selectFrom('job_runs')
      .innerJoin('backup_jobs', 'backup_jobs.id', 'job_runs.job_id')
      .select([
        'job_runs.id as run_id',
        'backup_jobs.target_id',
        'backup_jobs.restic_options',
        'backup_jobs.paths',
      ])
      .where('backup_jobs.agent_id', '=', agentId)
      .where('job_runs.status', '=', 'queued')
      .execute();

    const tasks: AgentTask[] = [];
    for (const run of runs) {
      // Claim the run so it is not handed out twice.
      const claimed = await this.db
        .updateTable('job_runs')
        .set({ status: 'running', agent_id: agentId, started_at: new Date() })
        .where('id', '=', run.run_id)
        .where('status', '=', 'queued')
        .returning('id')
        .executeTakeFirst();
      if (!claimed) continue;

      const resolved = await this.targets.resolve(run.target_id);
      tasks.push({
        type: 'backup',
        taskId: run.run_id,
        repository: resolved.repository,
        password: resolved.password,
        env: resolved.env,
        credentialFiles: resolved.credentialFiles,
        paths:
          typeof run.paths === 'string' ? JSON.parse(run.paths) : run.paths,
        options:
          typeof run.restic_options === 'string'
            ? JSON.parse(run.restic_options)
            : run.restic_options,
      });
    }
    return tasks;
  }

  private async claimRestoreTasks(agentId: string): Promise<AgentTask[]> {
    const runs = await this.db
      .selectFrom('restore_runs')
      .selectAll()
      .where('agent_id', '=', agentId)
      .where('status', '=', 'queued')
      .execute();

    const tasks: AgentTask[] = [];
    for (const run of runs) {
      const claimed = await this.db
        .updateTable('restore_runs')
        .set({ status: 'running', started_at: new Date() })
        .where('id', '=', run.id)
        .where('status', '=', 'queued')
        .returning('id')
        .executeTakeFirst();
      if (!claimed) continue;

      const resolved = await this.targets.resolve(run.target_id);
      const destination: RestoreDestination =
        typeof run.destination === 'string'
          ? JSON.parse(run.destination)
          : run.destination;
      const options: RestoreOptions =
        typeof run.options === 'string' ? JSON.parse(run.options) : run.options;
      const includedPaths = run.included_paths
        ? typeof run.included_paths === 'string'
          ? JSON.parse(run.included_paths)
          : run.included_paths
        : null;

      tasks.push({
        type: 'restore',
        taskId: run.id,
        repository: resolved.repository,
        password: resolved.password,
        env: resolved.env,
        credentialFiles: resolved.credentialFiles,
        snapshotId: run.snapshot_id,
        targetPath: destination.path || '/',
        includedPaths,
        restoreOptions: options,
      });
    }
    return tasks;
  }

  // --- Agent: task progress & result ---------------------------------------

  async backupProgress(
    agentId: string,
    taskId: string,
    stats: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .updateTable('job_runs')
      .set({ stats: JSON.stringify(stats) })
      .where('id', '=', taskId)
      .where('agent_id', '=', agentId)
      .execute();
  }

  async submitBackupResult(
    agentId: string,
    taskId: string,
    dto: TaskResultDto,
  ): Promise<void> {
    const run = await this.db
      .selectFrom('job_runs')
      .select('id')
      .where('id', '=', taskId)
      .where('agent_id', '=', agentId)
      .executeTakeFirst();
    if (!run) throw new NotFoundException('Task not found for this agent');

    await this.db
      .updateTable('job_runs')
      .set({
        status: dto.status,
        finished_at: new Date(),
        snapshot_id: dto.snapshotId ?? null,
        stats: dto.stats ? JSON.stringify(dto.stats) : null,
        forget_result: dto.forgetResult
          ? JSON.stringify(dto.forgetResult)
          : null,
        error: dto.error ?? null,
        log: dto.log ?? null,
      })
      .where('id', '=', taskId)
      .execute();

    // Fire configured notifications for the now-terminal run (best-effort).
    void this.notifications
      .notifyJobRun(taskId)
      .catch((e) => this.logger.warn(`Notify failed for run ${taskId}: ${e}`));
  }

  async restoreProgress(
    agentId: string,
    taskId: string,
    stats: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .updateTable('restore_runs')
      .set({ stats: JSON.stringify(stats) })
      .where('id', '=', taskId)
      .where('agent_id', '=', agentId)
      .execute();
  }

  async submitRestoreResult(
    agentId: string,
    taskId: string,
    dto: TaskResultDto,
  ): Promise<void> {
    const run = await this.db
      .selectFrom('restore_runs')
      .select('id')
      .where('id', '=', taskId)
      .where('agent_id', '=', agentId)
      .executeTakeFirst();
    if (!run) throw new NotFoundException('Task not found for this agent');

    await this.db
      .updateTable('restore_runs')
      .set({
        status: dto.status,
        finished_at: new Date(),
        stats: dto.stats ? JSON.stringify(dto.stats) : null,
        error: dto.error ?? null,
        log: dto.log ?? null,
      })
      .where('id', '=', taskId)
      .execute();
  }

  async submitResult(
    agentId: string,
    taskId: string,
    dto: TaskResultDto,
  ): Promise<{ ok: boolean }> {
    // Route to the correct run table.
    const jobRun = await this.db
      .selectFrom('job_runs')
      .select('id')
      .where('id', '=', taskId)
      .where('agent_id', '=', agentId)
      .executeTakeFirst();
    if (jobRun) {
      await this.submitBackupResult(agentId, taskId, dto);
    } else {
      await this.submitRestoreResult(agentId, taskId, dto);
    }
    return { ok: true };
  }

  async submitProgress(
    agentId: string,
    taskId: string,
    stats: Record<string, unknown>,
  ): Promise<{ ok: boolean }> {
    const jobRun = await this.db
      .selectFrom('job_runs')
      .select('id')
      .where('id', '=', taskId)
      .where('agent_id', '=', agentId)
      .executeTakeFirst();
    if (jobRun) await this.backupProgress(agentId, taskId, stats);
    else await this.restoreProgress(agentId, taskId, stats);
    return { ok: true };
  }

  // --- Offline detection ----------------------------------------------------

  @Interval(30_000)
  async sweepOffline(): Promise<void> {
    const timeout = loadConfig().agentOfflineTimeoutSeconds * 1000;
    const cutoff = new Date(Date.now() - timeout);
    await this.db
      .updateTable('agents')
      .set({ status: 'offline' })
      .where('status', '=', 'online')
      .where('last_seen_at', '<', cutoff)
      .execute()
      .catch((e) => this.logger.warn(`Offline sweep failed: ${e}`));
  }
}
