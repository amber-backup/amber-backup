import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Largest JSON body accepted on the agent channel. A task result carries the
 * run log and an inventory can list thousands of guests, far beyond the
 * 100 KiB default that still applies to every other route.
 */
export const AGENT_JSON_LIMIT_BYTES = 8 * 1024 * 1024;

/** Route prefix of the authenticated agent channel (poll, progress, state, result). */
export const AGENT_CHANNEL_PATH = '/api/agents/me';

type Next = (err?: unknown) => void;

function reply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ statusCode: status, message }));
}

/**
 * JSON body parser for the agent channel with a higher limit. Mounted before
 * Nest's own parser, which then sees the request as already read and skips it.
 * Anything that is not plain JSON (e.g. a compressed body) is left to that
 * default parser.
 */
export function agentJsonBodyParser(limit = AGENT_JSON_LIMIT_BYTES) {
  return (req: IncomingMessage & { body?: unknown }, res: ServerResponse, next: Next): void => {
    const type = String(req.headers['content-type'] ?? '').toLowerCase();
    const encoding = String(req.headers['content-encoding'] ?? 'identity').toLowerCase();
    const length = req.headers['content-length'];
    const hasBody = req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
    // Only a request that carries an agent credential gets the large limit
    // (the guard checks it later); anyone else stays at the default.
    const credentialed = /^Bearer\s+\S/i.test(String(req.headers.authorization ?? ''));
    if (
      !/^application\/([\w.-]+\+)?json\b/.test(type) ||
      encoding !== 'identity' ||
      !hasBody ||
      !credentialed
    ) {
      next();
      return;
    }
    if (length !== undefined && Number(length) > limit) {
      reply(res, 413, 'Request body too large');
      req.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        chunks.length = 0;
        reply(res, 413, 'Request body too large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => {
      if (!rejected) next(err);
      rejected = true;
    });
    req.on('end', () => {
      if (rejected) return;
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        req.body = text.trim() === '' ? {} : JSON.parse(text);
      } catch {
        reply(res, 400, 'Malformed JSON body');
        return;
      }
      next();
    });
  };
}
