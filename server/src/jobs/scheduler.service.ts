import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { JobsService } from './jobs.service';
import { JobRunnerService } from './job-runner.service';
import { CheckRunnerService, parseIntegrityConfig } from './check-runner.service';
import { SettingsService } from '../settings/settings.service';
import { BackupJobRow } from '../database/database.types';

/**
 * Registers a dynamic CronJob per enabled backup job. On tick it enqueues a
 * job_run and dispatches it (local → run now, agent → wait for poll). §7.
 * An enabled job with an integrity check schedule gets a second CronJob that
 * starts a check.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly jobs: JobsService,
    private readonly runner: JobRunnerService,
    private readonly checkRunner: CheckRunnerService,
    private readonly settings: SettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Cron expressions are read in the configured zone, so a change to it moves
    // every schedule — re-register them all.
    this.settings.onTimezoneChange((tz) => {
      this.logger.log(`Timezone changed to ${tz}; rescheduling backup jobs`);
      void this.syncAll();
    });
    await this.syncAll();
  }

  private cronName(jobId: string): string {
    return `backup-job:${jobId}`;
  }

  private checkCronName(jobId: string): string {
    return `check-job:${jobId}`;
  }

  /** Rebuilds all cron registrations from the database. */
  async syncAll(): Promise<void> {
    for (const name of this.registry.getCronJobs().keys()) {
      if (name.startsWith('backup-job:') || name.startsWith('check-job:')) {
        this.registry.deleteCronJob(name);
      }
    }
    const jobs = await this.jobs.listEnabled();
    for (const job of jobs) this.registerAll(job);
    this.logger.log(`Scheduled ${jobs.length} backup job(s)`);
  }

  /** Re-registers a single job (call after create/update/enable). */
  async sync(jobId: string): Promise<void> {
    this.unregister(jobId);
    const job = await this.jobs.getRow(jobId).catch(() => null);
    if (job && job.enabled) this.registerAll(job);
  }

  unregister(jobId: string): void {
    for (const name of [this.cronName(jobId), this.checkCronName(jobId)]) {
      if (this.registry.doesExist('cron', name)) {
        this.registry.deleteCronJob(name);
      }
    }
  }

  private registerAll(job: BackupJobRow): void {
    this.register(this.cronName(job.id), job.cron_expr, () => this.trigger(job.id));
    const check = parseIntegrityConfig(job.integrity_check);
    if (check.enabled && check.cronExpr) {
      this.register(this.checkCronName(job.id), check.cronExpr, () =>
        this.triggerCheck(job.id),
      );
    }
  }

  private register(
    name: string,
    cronExpr: string,
    onTick: () => Promise<void>,
  ): void {
    try {
      const job = new CronJob(
        cronExpr,
        () => {
          void onTick();
        },
        null,
        false,
        this.settings.getTimezone(),
      );
      this.registry.addCronJob(name, job as unknown as CronJob);
      job.start();
    } catch (e) {
      this.logger.error(`Failed to schedule ${name}: ${e}`);
    }
  }

  private async trigger(jobId: string): Promise<void> {
    try {
      const runId = await this.jobs.createRun(jobId, 'schedule');
      await this.runner.dispatch(runId);
    } catch (e) {
      this.logger.error(`Trigger for job ${jobId} failed: ${e}`);
    }
  }

  private async triggerCheck(jobId: string): Promise<void> {
    try {
      await this.checkRunner.start(jobId, 'schedule');
    } catch (e) {
      // A busy repository skips this tick; the next one tries again.
      if (e instanceof ConflictException) {
        this.logger.warn(`Scheduled check for job ${jobId} skipped: ${e.message}`);
      } else {
        this.logger.error(`Scheduled check for job ${jobId} failed: ${e}`);
      }
    }
  }
}
