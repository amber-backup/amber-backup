// Pure formatting helpers shared across pages.

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
  const fmt = (n: number, unit: string) => (ago ? `${n} ${unit} ago` : `in ${n} ${unit}`);
  if (abs < min) return ago ? 'just now' : 'soon';
  if (abs < hour) return fmt(Math.round(abs / min), 'min');
  if (abs < day) return fmt(Math.round(abs / hour), 'h');
  if (abs < 30 * day) return fmt(Math.round(abs / day), 'd');
  return new Date(date).toLocaleDateString('en-US');
}

export function fmtDateTime(date?: string | null): string {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    queued: 'queued',
    running: 'running',
    success: 'success',
    failed: 'failed',
    cancelled: 'cancelled',
    online: 'online',
    offline: 'offline',
    enrolled: 'connecting',
    error: 'error',
  };
  return map[status] ?? status;
}
