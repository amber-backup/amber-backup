import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Db, KYSELY } from '../database/database.module';
import { SecretsService } from '../crypto/secrets.service';
import { loadConfig } from '../config/configuration';
import { RequestUser } from '../common/auth/request-user';
import { uniqueSlug } from '../common/slug';
import { JobNotifyConfig, NotificationChannel } from '../database/database.types';
import {
  NotificationMessage,
  getChannel,
  splitChannelConfig,
} from './channel-registry';
import { CreateChannelDto, UpdateChannelDto } from './dto/channel.dto';

export type PublicChannel = Omit<NotificationChannel, 'secret_id'>;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly secrets: SecretsService,
  ) {}

  private toPublic(c: NotificationChannel): PublicChannel {
    const { secret_id, ...rest } = c;
    void secret_id;
    return rest;
  }

  async list(): Promise<PublicChannel[]> {
    const rows = await this.db
      .selectFrom('notification_channels')
      .selectAll()
      .orderBy('name', 'asc')
      .execute();
    return rows.map((c) => this.toPublic(c));
  }

  async getRow(id: string): Promise<NotificationChannel> {
    const c = await this.db
      .selectFrom('notification_channels')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!c) throw new NotFoundException('Notification channel not found');
    return c;
  }

  async get(id: string): Promise<PublicChannel> {
    return this.toPublic(await this.getRow(id));
  }

  async create(user: RequestUser, dto: CreateChannelDto): Promise<PublicChannel> {
    getChannel(dto.type); // validate type
    const { config, secrets } = splitChannelConfig(dto.type, dto.config);
    const secretId =
      Object.keys(secrets).length > 0
        ? await this.secrets.create('notification_credential', JSON.stringify(secrets))
        : null;

    const row = await this.db
      .insertInto('notification_channels')
      .values({
        name: dto.name,
        slug: await uniqueSlug(this.db, 'notification_channels', dto.name),
        type: dto.type,
        config: JSON.stringify(config),
        secret_id: secretId,
        enabled: dto.enabled ?? true,
        owner_id: user.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.toPublic(row);
  }

  async update(id: string, dto: UpdateChannelDto): Promise<PublicChannel> {
    const channel = await this.getRow(id);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (dto.name !== undefined) {
      patch.name = dto.name;
      // The slug follows the name; never user-editable.
      patch.slug = await uniqueSlug(
        this.db,
        'notification_channels',
        dto.name,
        id,
      );
    }
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;

    if (dto.config !== undefined) {
      const existingConfig = this.parseConfig(channel.config);
      const { config, secrets } = splitChannelConfig(channel.type, dto.config);
      // Merge non-secret config so untouched fields are preserved.
      patch.config = JSON.stringify({ ...existingConfig, ...config });
      if (Object.keys(secrets).length > 0) {
        // Merge over existing secrets: a blank secret field means "unchanged".
        const merged = { ...(await this.revealSecrets(channel)), ...secrets };
        if (channel.secret_id) {
          await this.secrets.update(channel.secret_id, JSON.stringify(merged));
        } else {
          patch.secret_id = await this.secrets.create(
            'notification_credential',
            JSON.stringify(merged),
          );
        }
      }
    }

    const row = await this.db
      .updateTable('notification_channels')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.toPublic(row);
  }

  async remove(id: string): Promise<void> {
    const channel = await this.getRow(id);
    await this.db.deleteFrom('notification_channels').where('id', '=', id).execute();
    if (channel.secret_id) await this.secrets.remove(channel.secret_id);
    // Drop this channel from any job's notify config.
    await this.pruneChannelFromJobs(id);
  }

  /** Sends a sample message through a channel to verify its configuration. */
  async test(id: string): Promise<{ ok: boolean; message: string }> {
    const channel = await this.getRow(id);
    const sample: NotificationMessage = {
      status: 'success',
      title: '✅ Amber Backup test notification',
      body: 'This is a test message from Amber Backup. Your channel works.',
      jobName: 'Test',
      url: loadConfig().publicBaseUrl.replace(/\/$/, ''),
    };
    try {
      await this.deliver(channel, sample);
      return { ok: true, message: 'Test notification sent.' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Delivery failed',
      };
    }
  }

  /**
   * Fires configured notifications for a finished job run. Best-effort: failures
   * to deliver are logged and never propagate to the run itself.
   */
  async notifyJobRun(jobRunId: string): Promise<void> {
    const run = await this.db
      .selectFrom('job_runs')
      .innerJoin('backup_jobs', 'backup_jobs.id', 'job_runs.job_id')
      .select([
        'job_runs.status',
        'job_runs.snapshot_id',
        'job_runs.error',
        'job_runs.started_at',
        'job_runs.finished_at',
        'backup_jobs.name as job_name',
        'backup_jobs.notify',
      ])
      .where('job_runs.id', '=', jobRunId)
      .executeTakeFirst();
    if (!run) return;
    if (run.status !== 'success' && run.status !== 'failed') return;

    const notify: JobNotifyConfig =
      typeof run.notify === 'string' ? JSON.parse(run.notify) : (run.notify ?? {});
    const wanted =
      run.status === 'success' ? notify.onSuccess : notify.onFailure;
    if (!wanted || !notify.channelIds?.length) return;

    const channels = await this.db
      .selectFrom('notification_channels')
      .selectAll()
      .where('id', 'in', notify.channelIds)
      .where('enabled', '=', true)
      .execute();
    if (channels.length === 0) return;

    const message = this.buildMessage(
      run.status,
      run.job_name,
      run.snapshot_id,
      run.error,
      run.started_at,
      run.finished_at,
    );

    await Promise.all(
      channels.map((c) =>
        this.deliver(c, message).catch((err) =>
          this.logger.warn(
            `Notification via "${c.name}" (${c.type}) failed: ${
              err instanceof Error ? err.message : err
            }`,
          ),
        ),
      ),
    );
  }

  /**
   * Delivers a pre-rendered message to a set of channels by id. Best-effort:
   * per-channel failures are logged and never propagate. Disabled or unknown
   * channels are skipped. Used by features (e.g. reports) that build their own
   * message rather than deriving one from a job run.
   */
  async sendToChannels(
    channelIds: string[],
    message: NotificationMessage,
  ): Promise<void> {
    if (channelIds.length === 0) return;
    const channels = await this.db
      .selectFrom('notification_channels')
      .selectAll()
      .where('id', 'in', channelIds)
      .where('enabled', '=', true)
      .execute();
    await Promise.all(
      channels.map((c) =>
        this.deliver(c, message).catch((err) =>
          this.logger.warn(
            `Notification via "${c.name}" (${c.type}) failed: ${
              err instanceof Error ? err.message : err
            }`,
          ),
        ),
      ),
    );
  }

  // --- internals ------------------------------------------------------------

  private async deliver(
    channel: NotificationChannel,
    message: NotificationMessage,
  ): Promise<void> {
    const def = getChannel(channel.type);
    const config = this.parseConfig(channel.config);
    const secrets = await this.revealSecrets(channel);
    await def.send(config, secrets, message);
  }

  private parseConfig(config: unknown): Record<string, unknown> {
    return typeof config === 'string'
      ? JSON.parse(config)
      : ((config as Record<string, unknown>) ?? {});
  }

  private async revealSecrets(
    channel: NotificationChannel,
  ): Promise<Record<string, string>> {
    if (!channel.secret_id) return {};
    const raw = await this.secrets.reveal(channel.secret_id);
    return JSON.parse(raw) as Record<string, string>;
  }

  private buildMessage(
    status: 'success' | 'failed',
    jobName: string,
    snapshotId: string | null,
    error: string | null,
    startedAt: Date | null,
    finishedAt: Date | null,
  ): NotificationMessage {
    const ok = status === 'success';
    const meta: { label: string; value: string }[] = [
      { label: 'Job', value: jobName },
      { label: 'Status', value: ok ? 'Success' : 'Failed' },
    ];
    if (startedAt && finishedAt) {
      const secs = Math.max(
        0,
        Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000),
      );
      meta.push({ label: 'Duration', value: `${secs}s` });
    }
    if (ok && snapshotId) {
      meta.push({ label: 'Snapshot', value: snapshotId.slice(0, 8) });
    }
    if (!ok && error) meta.push({ label: 'Error', value: error });
    return {
      status,
      title: `${ok ? '✅' : '❌'} Backup ${ok ? 'succeeded' : 'failed'}: ${jobName}`,
      body: meta.map((m) => `${m.label}: ${m.value}`).join('\n'),
      jobName,
      url: `${loadConfig().publicBaseUrl.replace(/\/$/, '')}/#/jobs`,
      meta,
    };
  }

  /** Removes a deleted channel id from every job's notify config. */
  private async pruneChannelFromJobs(channelId: string): Promise<void> {
    const jobs = await this.db
      .selectFrom('backup_jobs')
      .select(['id', 'notify'])
      .execute();
    for (const job of jobs) {
      const notify: JobNotifyConfig =
        typeof job.notify === 'string' ? JSON.parse(job.notify) : (job.notify ?? {});
      if (!notify.channelIds?.includes(channelId)) continue;
      notify.channelIds = notify.channelIds.filter((id) => id !== channelId);
      await this.db
        .updateTable('backup_jobs')
        .set({ notify: JSON.stringify(notify), updated_at: new Date() })
        .where('id', '=', job.id)
        .execute();
    }
  }
}
