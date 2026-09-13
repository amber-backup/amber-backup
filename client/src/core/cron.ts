// Cron expression helpers shared by the schedule editors.

/** Human-readable summary of a cron expression, or null if not recognized. */
export function describeCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, hr, dom, mon, dow] = parts;
  const isNum = (s: string): boolean => /^\d+$/.test(s);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const at = isNum(hr) && isNum(m) ? `${hr.padStart(2, '0')}:${m.padStart(2, '0')}` : null;
  if (m === '0' && hr === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour';
  if (m === '0' && /^\*\/\d+$/.test(hr) && dom === '*' && mon === '*' && dow === '*') return `Every ${hr.slice(2)} hours`;
  if (at && dom === '*' && mon === '*' && dow === '*') return `Every day at ${at}`;
  if (at && dom === '*' && mon === '*' && isNum(dow)) return `Every week on ${days[Number(dow) % 7]} at ${at}`;
  if (at && isNum(dom) && mon === '*' && dow === '*') return `Every month on day ${dom} at ${at}`;
  return null;
}
