import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { JobsService } from './jobs.service';
import { JobRunnerService } from './job-runner.service';

/**
 * Registers a dynamic CronJob per enabled backup job. On tick it enqueues a
 * job_run and dispatches it (local → run now, agent → wait for poll). §7.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly jobs: JobsService,
    private readonly runner: JobRunnerService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.syncAll();
  }

  private cronName(jobId: string): string {
    return `backup-job:${jobId}`;
  }

  /** Rebuilds all cron registrations from the database. */
  async syncAll(): Promise<void> {
    for (const name of this.registry.getCronJobs().keys()) {
      if (name.startsWith('backup-job:')) this.registry.deleteCronJob(name);
    }
    const jobs = await this.jobs.listEnabled();
    for (const job of jobs) this.register(job.id, job.cron_expr);
    this.logger.log(`Scheduled ${jobs.length} backup job(s)`);
  }

  /** Re-registers a single job (call after create/update/enable). */
  async sync(jobId: string): Promise<void> {
    this.unregister(jobId);
    const job = await this.jobs.getRow(jobId).catch(() => null);
    if (job && job.enabled) this.register(job.id, job.cron_expr);
  }

  unregister(jobId: string): void {
    const name = this.cronName(jobId);
    if (this.registry.doesExist('cron', name)) {
      this.registry.deleteCronJob(name);
    }
  }

  private register(jobId: string, cronExpr: string): void {
    const name = this.cronName(jobId);
    try {
      const job = new CronJob(cronExpr, () => {
        void this.trigger(jobId);
      });
      this.registry.addCronJob(name, job as unknown as CronJob);
      job.start();
    } catch (e) {
      this.logger.error(`Failed to schedule job ${jobId}: ${e}`);
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
}
