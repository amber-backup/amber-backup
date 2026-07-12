import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const logger = new Logger('HTTP');

// Query-string keys whose values may be credentials/secrets (OIDC codes, API
// tokens, …); their values are masked before the URL is logged.
const SENSITIVE_QUERY =
  /\b(access_token|id_token|client_secret|code|state|token|password|secret|key)=[^&\s]*/gi;

function redactUrl(url: string): string {
  return url.replace(SENSITIVE_QUERY, (m) => `${m.slice(0, m.indexOf('='))}=***`);
}

/**
 * HTTP access log — one line per request with method, path, response status,
 * duration and (when known) response size. Applied globally via `app.use` in
 * `main.ts`, so it also covers requests rejected by guards (401/403), 404s and
 * static SPA assets, which handler-level interceptors never see. The log level
 * follows the status class: 5xx → error, 4xx → warn, otherwise info.
 *
 * Toggle with the `HTTP_LOGGING` env var (on by default).
 */
export function httpLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const method = req.method;
  const url = redactUrl(req.originalUrl || req.url);

  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const len = res.getHeader('content-length');
    const size =
      typeof len === 'string' || typeof len === 'number' ? ` ${len}b` : '';
    const line = `${method} ${url} ${status} ${ms}ms${size}`;
    if (status >= 500) logger.error(line);
    else if (status >= 400) logger.warn(line);
    else logger.log(line);
  });

  next();
}
