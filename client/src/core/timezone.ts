// The display timezone, a global setting maintained by administrators. It is
// loaded once per session and mirrored at module level so non-React helpers
// (format.ts, cron.ts) can read it, the way i18n exposes the active locale.

import { api } from './api';

let current: string | null = null;

/**
 * Zone all timestamps are rendered in, or undefined while it is still loading —
 * `toLocaleString` then falls back to the browser's own zone.
 */
export function appTimezone(): string | undefined {
  return current ?? undefined;
}

export function setAppTimezone(timezone: string): void {
  current = timezone;
}

/** Fetches the global display timezone; failures leave the browser zone in place. */
export async function loadAppTimezone(): Promise<void> {
  try {
    const settings = await api.get<{ timezone: string }>('/settings/app');
    setAppTimezone(settings.timezone);
  } catch {
    /* not signed in, or the server is unreachable — keep the browser zone */
  }
}
