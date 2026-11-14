import { CronTime } from 'cron';

/**
 * Cron handling shared by the API (validation, `next_run`) and the schedulers.
 * All of it goes through the `cron` package's `CronTime` — the same parser
 * that registers the `CronJob`s — so an expression the API accepts is one the
 * scheduler can run, and the next run shown in the UI is the one it fires at.
 * (cron-parser, used before, accepts `L`, `#` and `?`, which `cron` rejects:
 * such a job was saved but never scheduled.)
 */

/** Why `expr` cannot be scheduled, or null when it can. */
export function cronError(expr: string, timeZone?: string): string | null {
  if (typeof expr !== 'string' || !expr.trim()) {
    return 'The cron expression is empty';
  }
  try {
    const time = new CronTime(expr.trim(), timeZone || undefined);
    // An expression that parses but never fires (e.g. "0 0 31 2 *") throws
    // here; it would never run either.
    time.sendAt();
    return null;
  } catch (e) {
    // cron appends a multi-line debug dump to some messages; keep the gist.
    const message = e instanceof Error ? e.message : String(e);
    return message.split('\n')[0].trim() || 'Invalid cron expression';
  }
}

/** Throws a readable error when `expr` cannot be scheduled. */
export function assertValidCron(expr: string, timeZone?: string): void {
  const error = cronError(expr, timeZone);
  if (error) throw new Error(`Invalid cron expression "${expr}": ${error}`);
}

/** The next time `expr` fires in `timeZone`, or null when it cannot be scheduled. */
export function nextCronRun(
  expr: string,
  timeZone?: string,
  from: Date = new Date(),
): Date | null {
  try {
    const time = new CronTime(expr.trim(), timeZone || undefined);
    return time.getNextDateFrom(from, timeZone || undefined).toJSDate();
  } catch {
    return null;
  }
}
