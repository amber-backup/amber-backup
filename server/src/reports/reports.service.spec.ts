import { ReportsService } from './reports.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { Db } from '../database/database.module';

describe('ReportsService next run timezone', () => {
  function make(timezone: string) {
    return new ReportsService(
      {} as unknown as Db,
      {} as unknown as NotificationsService,
      { getTimezone: () => timezone } as unknown as SettingsService,
    );
  }

  it('reads a cron expression in the configured timezone', () => {
    const utc = make('UTC').nextRun('0 7 * * 1')!;
    const tokyo = make('Asia/Tokyo').nextRun('0 7 * * 1')!;

    expect(utc.getUTCHours()).toBe(7);
    // Tokyo is nine hours ahead all year, so 07:00 there is 22:00 UTC.
    expect(tokyo.getUTCHours()).toBe(22);
  });

  it('returns null for an expression it cannot parse', () => {
    expect(make('UTC').nextRun('not a cron')).toBeNull();
  });
});
