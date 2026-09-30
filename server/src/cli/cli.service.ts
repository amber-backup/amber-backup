import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { readFileSync } from 'fs';
import * as path from 'path';
import { loadConfig } from '../config/configuration';
import { readBundledVersion } from '../common/bundled-version';

export type CliScriptKind = 'sh' | 'ps1';

interface ScriptSpec {
  file: string;
  /** Renders the default-version line for a given value. */
  version: (value: string) => string;
  /** Renders the default-server-URL line for a given value. */
  url: (value: string) => string;
}

/**
 * The marker lines each script ships with (rendered with 'latest' / ''). The
 * served copy swaps in this server's values; an env var set by the user still
 * wins over them.
 */
const SCRIPTS: Record<CliScriptKind, ScriptSpec> = {
  sh: {
    file: 'install.sh',
    version: (v) => `AMBB_VERSION="\${AMBB_VERSION:-${v}}"`,
    url: (u) => `AMBER_URL="\${AMBER_URL:-${u}}"`,
  },
  ps1: {
    file: 'install.ps1',
    version: (v) =>
      `$Version = if ($env:AMBB_VERSION) { $env:AMBB_VERSION } else { '${v}' }`,
    url: (u) =>
      `$AmberUrl = if ($env:AMBER_URL) { $env:AMBER_URL } else { '${u}' }`,
  },
};

// Only values matching these are injected into a script. Neither admits a
// quote, `$`, backtick, backslash or brace, so nothing can break out of the
// sh double-quoted or PowerShell single-quoted literal.
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~/-]*)?$/;

/** Serves the ambb CLI install scripts with this server's defaults filled in. */
@Injectable()
export class CliService {
  private readonly logger = new Logger(CliService.name);

  installScript(kind: CliScriptKind): string {
    const spec = SCRIPTS[kind];
    const config = loadConfig();
    const file = path.join(path.resolve(config.cliScriptDir), spec.file);
    let script: string;
    try {
      script = readFileSync(file, 'utf8');
    } catch {
      throw new NotFoundException(
        `CLI install script ${spec.file} is not available on this server`,
      );
    }

    const version = readBundledVersion();
    const baseUrl = config.publicBaseUrl.replace(/\/+$/, '');
    script = this.replaceDefault(
      script,
      spec.file,
      spec.version('latest'),
      version && VERSION_RE.test(version) ? spec.version(version) : null,
    );
    return this.replaceDefault(
      script,
      spec.file,
      spec.url(''),
      URL_RE.test(baseUrl) ? spec.url(baseUrl) : null,
    );
  }

  /**
   * Replaces the single line equal to `marker` (ignoring indentation) with
   * `replacement`, or leaves it as is when `replacement` is null. A missing or
   * duplicated marker means the script and this service drifted apart — fail
   * rather than serve a script without the server's defaults.
   */
  private replaceDefault(
    script: string,
    file: string,
    marker: string,
    replacement: string | null,
  ): string {
    const lines = script.split('\n');
    const matches = lines.flatMap((l, i) => (l.trim() === marker ? [i] : []));
    if (matches.length !== 1) {
      this.logger.error(
        `${file}: expected exactly one default line "${marker}", found ${matches.length}`,
      );
      throw new InternalServerErrorException(
        `CLI install script ${file} is malformed`,
      );
    }
    if (replacement === null) return script;
    const i = matches[0];
    const indent = lines[i].slice(0, lines[i].length - lines[i].trimStart().length);
    lines[i] = indent + replacement;
    return lines.join('\n');
  }
}
