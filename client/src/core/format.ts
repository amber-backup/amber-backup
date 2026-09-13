// Pure formatting helpers shared across pages.

import { intlLocale, messages } from '../i18n';

export function fmtBytes(bytes?: number | null): string {
  if (bytes == null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function fmtRelative(date?: string | null): string {
  if (!date) return '—';
  const diff = Date.now() - new Date(date).getTime();
  const abs = Math.abs(diff);
  const min = 60_000,
    hour = 3_600_000,
    day = 86_400_000;
  const ago = diff >= 0;
  const m = messages().common.format;
  const fmt = (n: number, unit: string) => (ago ? m.ago(n, unit) : m.in(n, unit));
  if (abs < min) return ago ? m.justNow : m.soon;
  if (abs < hour) return fmt(Math.round(abs / min), m.unitMin);
  if (abs < day) return fmt(Math.round(abs / hour), m.unitHour);
  if (abs < 30 * day) return fmt(Math.round(abs / day), m.unitDay);
  return new Date(date).toLocaleDateString(intlLocale());
}

/** Human-readable elapsed time, e.g. "42 s", "3 min 12 s", "1 h 05 min". */
export function fmtDuration(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  if (total < 1) return '<1 s';
  if (total < 60) return `${total} s`;
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (min < 60) return sec ? `${min} min ${sec} s` : `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, '0')} min`;
}

/**
 * Milliseconds a run has taken: from its start to its end, or to now while it
 * is still running. Null when it never started.
 */
export function runDurationMs(run: { started_at: string | null; finished_at: string | null }): number | null {
  if (!run.started_at) return null;
  const end = run.finished_at ? new Date(run.finished_at).getTime() : Date.now();
  return end - new Date(run.started_at).getTime();
}

export function fmtDateTime(date?: string | null): string {
  if (!date) return '—';
  return new Date(date).toLocaleString(intlLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function statusLabel(status: string): string {
  return messages().common.status[status] ?? status;
}

/** True when semver `candidate` (e.g. "1.29.0") is newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.+-]/, 3).map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
