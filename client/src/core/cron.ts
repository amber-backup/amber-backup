// Cron expression helpers shared by the schedule editors.

import { messages } from '../i18n';
import { appTimezone } from './timezone';

/** Human-readable summary of a cron expression, or null if not recognized. */
export function describeCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, hr, dom, mon, dow] = parts;
  const isNum = (s: string): boolean => /^\d+$/.test(s);
  const c = messages().common.cron;
  const at = isNum(hr) && isNum(m) ? `${hr.padStart(2, '0')}:${m.padStart(2, '0')}` : null;
  if (m === '0' && hr === '*' && dom === '*' && mon === '*' && dow === '*') return c.everyHour;
  if (m === '0' && /^\*\/\d+$/.test(hr) && dom === '*' && mon === '*' && dow === '*') return c.everyNHours(hr.slice(2));
  if (at && dom === '*' && mon === '*' && dow === '*') return withZone(c.everyDayAt(at));
  if (at && dom === '*' && mon === '*' && isNum(dow))
    return withZone(c.everyWeekOn(c.days[Number(dow) % 7], at));
  if (at && isNum(dom) && mon === '*' && dow === '*') return withZone(c.everyMonthOn(dom, at));
  return null;
}

/** Names the zone a wall-clock time is read in, once it is known. */
function withZone(text: string): string {
  const tz = appTimezone();
  return tz ? `${text} (${tz})` : text;
}
