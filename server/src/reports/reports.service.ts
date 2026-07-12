import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import parser from 'cron-parser';
import { Db, KYSELY } from '../database/database.module';
import { RequestUser } from '../common/auth/request-user';
import { loadConfig } from '../config/configuration';
import {
  Report,
  ReportDataset,
  ReportWindow,
  RunStatus,
} from '../database/database.types';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationMessage } from '../notifications/channel-registry';
import { CreateReportDto, UpdateReportDto } from './dto/report.dto';

/** Look-back window tokens → duration in days. */
const WINDOW_DAYS: Record<ReportWindow, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '6mo': 180,
  '12mo': 365,
};

const WINDOW_LABEL: Record<ReportWindow, string> = {
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  '90d': 'last 90 days',
  '6mo': 'last 6 months',
  '12mo': 'last 12 months',
};

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {}

  private validateCron(expr: string): void {
    try {
      parser.parseExpression(expr);
    } catch {
      throw new BadRequestException(`Invalid cron expression: ${expr}`);
    }
  }

  nextRun(expr: string): Date | null {
    try {
      return parser.parseExpression(expr).next().toDate();
    } catch {
      return null;
    }
  }

  private parseDataset(dataset: unknown): ReportDataset {
    return typeof dataset === 'string'
      ? (JSON.parse(dataset) as ReportDataset)
      : (dataset as ReportDataset);
  }

  /** Reports are an admin-only feature (they target admin-only channels). */
  async list(): Promise<Report[]> {
    return this.db
      .selectFrom('reports')
      .selectAll()
      .orderBy('name', 'asc')
      .execute();
  }

  /** All enabled reports — for the scheduler. */
  async listEnabled(): Promise<Report[]> {
    return this.db
      .selectFrom('reports')
      .selectAll()
      .where('enabled', '=', true)
      .execute();
  }

  async getRow(id: string): Promise<Report> {
    const r = await this.db
      .selectFrom('reports')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw new NotFoundException('Report not found');
    return r;
  }

  async get(id: string): Promise<Report> {
    return this.getRow(id);
  }

  async create(user: RequestUser, dto: CreateReportDto): Promise<Report> {
    this.validateCron(dto.cronExpr);
    return this.db
      .insertInto('reports')
      .values({
        name: dto.name,
        tags: JSON.stringify(dto.tags ?? []),
        dataset: JSON.stringify(dto.dataset),
        cron_expr: dto.cronExpr,
        channel_ids: JSON.stringify(dto.channelIds),
        enabled: dto.enabled ?? true,
        owner_id: user.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(id: string, dto: UpdateReportDto): Promise<Report> {
    await this.getRow(id);
    if (dto.cronExpr) this.validateCron(dto.cronExpr);

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.tags !== undefined) patch.tags = JSON.stringify(dto.tags);
    if (dto.dataset !== undefined) patch.dataset = JSON.stringify(dto.dataset);
    if (dto.cronExpr !== undefined) patch.cron_expr = dto.cronExpr;
    if (dto.channelIds !== undefined)
      patch.channel_ids = JSON.stringify(dto.channelIds);
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;

    return this.db
      .updateTable('reports')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async remove(id: string): Promise<void> {
    await this.getRow(id);
    await this.db.deleteFrom('reports').where('id', '=', id).execute();
  }

  /**
   * Renders a report and delivers it to its channels, then records the run.
   * Best-effort delivery is handled by the notifications service.
   */
  async generate(id: string): Promise<void> {
    const report = await this.getRow(id);
    const dataset = this.parseDataset(report.dataset);
    const message = await this.buildMessage(report.name, dataset);

    const channelIds = this.parseIds(report.channel_ids);
    await this.notifications.sendToChannels(channelIds, message);

    await this.db
      .updateTable('reports')
      .set({ last_run_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  private parseIds(value: unknown): string[] {
    return typeof value === 'string'
      ? (JSON.parse(value) as string[])
      : ((value as string[]) ?? []);
  }

  /** Aggregates the dataset into a plain-text notification message. */
  private async buildMessage(
    name: string,
    dataset: ReportDataset,
  ): Promise<NotificationMessage> {
    const jobIds = dataset.jobIds ?? [];
    const statuses = (dataset.statuses ?? []) as RunStatus[];
    const days = WINDOW_DAYS[dataset.window] ?? 7;
    const cutoff = new Date(Date.now() - days * 86400_000);

    // job_id → status → count, plus each job's display name.
    const counts = new Map<string, Map<string, number>>();
    const names = new Map<string, string>();

    if (jobIds.length > 0 && statuses.length > 0) {
      const rows = await this.db
        .selectFrom('job_runs')
        .innerJoin('backup_jobs', 'backup_jobs.id', 'job_runs.job_id')
        .select([
          'job_runs.job_id',
          'backup_jobs.name as job_name',
          'job_runs.status',
        ])
        .select((eb) => eb.fn.countAll<number>().as('c'))
        .where('job_runs.job_id', 'in', jobIds)
        .where('job_runs.status', 'in', statuses)
        .where('job_runs.created_at', '>', cutoff)
        .groupBy(['job_runs.job_id', 'backup_jobs.name', 'job_runs.status'])
        .execute();

      for (const row of rows) {
        names.set(row.job_id, row.job_name);
        const byStatus = counts.get(row.job_id) ?? new Map<string, number>();
        byStatus.set(row.status, Number(row.c));
        counts.set(row.job_id, byStatus);
      }
    }

    // Ensure jobs with zero matching runs still appear, by their name.
    const jobNameRows =
      jobIds.length > 0
        ? await this.db
            .selectFrom('backup_jobs')
            .select(['id', 'name'])
            .where('id', 'in', jobIds)
            .execute()
        : [];
    for (const j of jobNameRows) if (!names.has(j.id)) names.set(j.id, j.name);

    const statusTitle: Record<string, string> = {
      success: 'Success',
      failed: 'Failed',
    };
    let totalSuccess = 0;
    let totalFailed = 0;
    const lines: string[] = [];
    const tableRows: string[][] = [];
    const statusTotals = new Map<string, number>();
    for (const jobId of jobIds) {
      const byStatus = counts.get(jobId) ?? new Map<string, number>();
      const parts: string[] = [];
      const row: string[] = [names.get(jobId) ?? jobId];
      for (const status of statuses) {
        const n = byStatus.get(status) ?? 0;
        if (status === 'success') totalSuccess += n;
        if (status === 'failed') totalFailed += n;
        statusTotals.set(status, (statusTotals.get(status) ?? 0) + n);
        parts.push(`${n} ${status}`);
        row.push(String(n));
      }
      lines.push(`${names.get(jobId) ?? jobId}: ${parts.join(', ')}`);
      tableRows.push(row);
    }
    // Append a totals row when more than one job is summarized.
    if (tableRows.length > 1) {
      tableRows.push([
        'Total',
        ...statuses.map((s) => String(statusTotals.get(s) ?? 0)),
      ]);
    }

    const status: NotificationMessage['status'] =
      totalFailed > 0 ? 'failed' : 'success';
    const icon = totalFailed > 0 ? '⚠️' : '✅';
    const windowLabel = WINDOW_LABEL[dataset.window] ?? dataset.window;

    const body = [
      `Report: ${name}`,
      `Window: ${windowLabel}`,
      '',
      ...(lines.length ? lines : ['No jobs selected.']),
      '',
      `Totals: ${totalSuccess} success, ${totalFailed} failed`,
    ].join('\n');

    return {
      status,
      title: `${icon} Backup report: ${name}`,
      body,
      jobName: name,
      url: `${loadConfig().publicBaseUrl.replace(/\/$/, '')}/#/reports`,
      meta: [
        { label: 'Window', value: windowLabel },
        {
          label: 'Totals',
          value: `${totalSuccess} success, ${totalFailed} failed`,
        },
      ],
      table: tableRows.length
        ? {
            head: ['Job', ...statuses.map((s) => statusTitle[s] ?? s)],
            rows: tableRows,
          }
        : undefined,
    };
  }
}
