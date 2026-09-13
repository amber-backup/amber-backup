import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { loadConfig } from '../config/configuration';
import { UpdateStatusDto } from './dto/update-status.dto';

/** GitHub repository whose releases are Amber Backup versions. */
export const RELEASE_REPO = 'amber-backup/amber-backup';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

const CHECK_INTERVAL_MS = 6 * 3600_000;
const CHECK_TIMEOUT_MS = 10_000;

/** Same tag shape the release pipeline (and `ambb update`) relies on. */
const RELEASE_TAG_RE = /^v(\d+\.\d+\.\d+)$/;

/**
 * Periodically reads the newest GitHub release so the UI can hint at an
 * available upgrade. One cached lookup serves all browsers, which keeps us far
 * below GitHub's unauthenticated rate limit. Comparing against the running
 * version happens in the client, which carries the build's version.
 * Disabled with UPDATE_CHECK_ENABLED=false (e.g. air-gapped installs).
 */
@Injectable()
export class UpdateCheckService implements OnModuleInit {
  private readonly logger = new Logger(UpdateCheckService.name);
  private status: UpdateStatusDto = {
    latestVersion: null,
    releaseUrl: null,
    checkedAt: null,
  };

  onModuleInit(): void {
    // Not awaited: a slow or unreachable GitHub must not delay startup.
    void this.check();
  }

  getStatus(): UpdateStatusDto {
    return { ...this.status };
  }

  @Interval(CHECK_INTERVAL_MS)
  async check(): Promise<void> {
    if (!loadConfig().updateCheckEnabled) return;
    try {
      const res = await fetch(LATEST_RELEASE_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'amber-backup',
        },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
      const body = (await res.json()) as {
        tag_name?: unknown;
        html_url?: unknown;
      };
      const match = RELEASE_TAG_RE.exec(String(body.tag_name ?? ''));
      if (!match) {
        throw new Error(`unexpected release tag "${String(body.tag_name)}"`);
      }
      this.status = {
        latestVersion: match[1],
        releaseUrl: releasePageUrl(body.html_url, String(body.tag_name)),
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.logger.warn(
        `Update check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * The UI links straight to this URL, so only a github.com release page of our
 * repository is accepted; anything else falls back to the canonical tag URL.
 */
function releasePageUrl(htmlUrl: unknown, tag: string): string {
  const prefix = `https://github.com/${RELEASE_REPO}/releases/`;
  if (typeof htmlUrl === 'string' && htmlUrl.startsWith(prefix)) return htmlUrl;
  return `${prefix}tag/${encodeURIComponent(tag)}`;
}
