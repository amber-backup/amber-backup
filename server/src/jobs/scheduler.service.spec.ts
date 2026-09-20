import { CronJob } from 'cron';
import { SchedulerRegistry } from '@nestjs/schedule';
import { SchedulerService } from './scheduler.service';
import { JobsService } from './jobs.service';
import { JobRunnerService } from './job-runner.service';
import { CheckRunnerService } from './check-runner.service';
import { SettingsService } from '../settings/settings.service';
import { BackupJobRow } from '../database/database.types';

/** Map-backed stand-in for Nest's registry, stopping jobs as the real one does. */
function createRegistry() {
  const jobs = new Map<string, CronJob>();
  const registry = {
    getCronJobs: () => jobs,
    addCronJob: (name: string, job: CronJob) => jobs.set(name, job),
    deleteCronJob: (name: string) => {
      jobs.get(name)?.stop();
      jobs.delete(name);
    },
    doesExist: (_type: string, name: string) => jobs.has(name),
  };
  return { jobs, registry: registry as unknown as SchedulerRegistry };
}

describe('SchedulerService timezone', () => {
  const job = {
    id: 'job-1',
    enabled: true,
    cron_expr: '0 3 * * *',
    integrity_check: null,
  } as unknown as BackupJobRow;

  function make(timezone: string) {
    const { jobs, registry } = createRegistry();
    let onChange: ((tz: string) => void) | null = null;
    let tz = timezone;
    const settings = {
      getTimezone: () => tz,
      onTimezoneChange: (cb: (next: string) => void) => {
        onChange = cb;
      },
    };
    const service = new SchedulerService(
      registry,
      { listEnabled: () => Promise.resolve([job]), getRow: () => Promise.resolve(job) } as unknown as JobsService,
      {} as unknown as JobRunnerService,
      {} as unknown as CheckRunnerService,
      settings as unknown as SettingsService,
    );
    return {
      service,
      jobs,
      changeTimezone: async (next: string) => {
        tz = next;
        onChange?.(next);
        await new Promise(setImmediate);
      },
    };
  }

  afterEach(() => jest.restoreAllMocks());

  it('registers a backup job in the configured timezone', async () => {
    const { service, jobs } = make('Europe/Berlin');
    await service.onModuleInit();

    expect(jobs.get('backup-job:job-1')!.cronTime.timeZone).toBe('Europe/Berlin');
    service.unregister('job-1');
  });

  it('re-registers every job when the timezone changes', async () => {
    const { service, jobs, changeTimezone } = make('Europe/Berlin');
    await service.onModuleInit();

    await changeTimezone('Asia/Tokyo');

    expect(jobs.get('backup-job:job-1')!.cronTime.timeZone).toBe('Asia/Tokyo');
    service.unregister('job-1');
  });
});
