import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ReportsService } from './reports.service';

/**
 * Registers a dynamic CronJob per enabled report. On tick it renders the report
 * and delivers it to its channels. Mirrors the backup-job SchedulerService.
 */
@Injectable()
export class ReportSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(ReportSchedulerService.name);

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly reports: ReportsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.syncAll();
  }

  private cronName(reportId: string): string {
    return `report:${reportId}`;
  }

  /** Rebuilds all report cron registrations from the database. */
  async syncAll(): Promise<void> {
    for (const name of this.registry.getCronJobs().keys()) {
      if (name.startsWith('report:')) this.registry.deleteCronJob(name);
    }
    const reports = await this.reports.listEnabled();
    for (const report of reports) this.register(report.id, report.cron_expr);
    this.logger.log(`Scheduled ${reports.length} report(s)`);
  }

  /** Re-registers a single report (call after create/update/enable). */
  async sync(reportId: string): Promise<void> {
    this.unregister(reportId);
    const report = await this.reports.getRow(reportId).catch(() => null);
    if (report && report.enabled) this.register(report.id, report.cron_expr);
  }

  unregister(reportId: string): void {
    const name = this.cronName(reportId);
    if (this.registry.doesExist('cron', name)) {
      this.registry.deleteCronJob(name);
    }
  }

  private register(reportId: string, cronExpr: string): void {
    const name = this.cronName(reportId);
    try {
      const job = new CronJob(cronExpr, () => {
        void this.trigger(reportId);
      });
      this.registry.addCronJob(name, job as unknown as CronJob);
      job.start();
    } catch (e) {
      this.logger.error(`Failed to schedule report ${reportId}: ${e}`);
    }
  }

  private async trigger(reportId: string): Promise<void> {
    try {
      await this.reports.generate(reportId);
    } catch (e) {
      this.logger.error(`Report ${reportId} generation failed: ${e}`);
    }
  }
}
