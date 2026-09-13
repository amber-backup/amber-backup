import { useEffect, useState } from 'react';
import { api, type UpdateStatus } from '../core/api';
import { isNewerVersion } from '../core/format';

/** How often the (server-cached) release status is re-read. */
const POLL_INTERVAL_MS = 60 * 60_000;

export interface AvailableUpdate {
  version: string;
  releaseUrl: string;
}

/**
 * Returns the newest release when it is newer than the running build, else
 * null. Failures are silent — the upgrade hint is purely informational.
 */
export function useUpdateCheck(): AvailableUpdate | null {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => {
      api
        .get<UpdateStatus>('/updates/latest')
        .then((s) => {
          if (!active) return;
          setUpdate(
            s.latestVersion && s.releaseUrl && isNewerVersion(s.latestVersion, __APP_VERSION__)
              ? { version: s.latestVersion, releaseUrl: s.releaseUrl }
              : null,
          );
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return update;
}
