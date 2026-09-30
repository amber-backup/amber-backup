import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { loadConfig } from '../config/configuration';

/**
 * Release version of this server build, read from `<agentBinaryDir>/version`.
 * The image writes it from `agent/VERSION`, which the release keeps in sync
 * with the root package version. Null when unknown (e.g. local dev without a
 * built agent).
 */
export function readBundledVersion(): string | null {
  try {
    const file = path.join(path.resolve(loadConfig().agentBinaryDir), 'version');
    return existsSync(file) ? readFileSync(file, 'utf8').trim() || null : null;
  } catch {
    return null;
  }
}
