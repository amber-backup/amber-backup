import { CronJob } from 'cron';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ReportSchedulerService } from './report-scheduler.service';
import { ReportsService } from './reports.service';
import { SettingsService } from '../settings/settings.service';

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

describe('ReportSchedulerService timezone', () => {
  const report = { id: 'rep-1', enabled: true, cron_expr: '0 7 * * 1' };

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
    const service = new ReportSchedulerService(
      registry,
      { listEnabled: () => Promise.resolve([report]) } as unknown as ReportsService,
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

  it('registers a report in the configured timezone', async () => {
    const { service, jobs } = make('Europe/Berlin');
    await service.onModuleInit();

    expect(jobs.get('report:rep-1')!.cronTime.timeZone).toBe('Europe/Berlin');
    service.unregister('rep-1');
  });

  it('re-registers every report when the timezone changes', async () => {
    const { service, jobs, changeTimezone } = make('Europe/Berlin');
    await service.onModuleInit();

    await changeTimezone('Asia/Tokyo');

    expect(jobs.get('report:rep-1')!.cronTime.timeZone).toBe('Asia/Tokyo');
    service.unregister('rep-1');
  });
});
