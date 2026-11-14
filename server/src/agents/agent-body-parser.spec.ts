import { EventEmitter } from 'events';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { ExpressAdapter } from '@nestjs/platform-express';
import {
  AGENT_CHANNEL_PATH,
  agentJsonBodyParser,
  AGENT_JSON_LIMIT_BYTES,
} from './agent-body-parser';
import { truncateMiddle } from '../common/truncate';

/** A request stream that emits `body` in chunks once listened to. */
function request(body: string | Buffer, headers: Record<string, string> = {}) {
  const req = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    body?: unknown;
    resume: () => void;
  };
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(buf.length),
    authorization: 'Bearer agent-key',
    ...headers,
  };
  req.resume = () => undefined;
  setImmediate(() => {
    for (let i = 0; i < buf.length; i += 1 << 20) req.emit('data', buf.subarray(i, i + (1 << 20)));
    req.emit('end');
  });
  return req;
}

function response() {
  const res = {
    statusCode: 200,
    headersSent: false,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(chunk: string) {
      this.body = chunk;
      this.headersSent = true;
    },
  };
  return res;
}

function run(req: ReturnType<typeof request>, res = response(), limit?: number) {
  return new Promise<{ nextCalled: boolean; res: typeof res }>((resolve) => {
    const parser = agentJsonBodyParser(limit);
    parser(req as unknown as IncomingMessage, res as unknown as ServerResponse, () =>
      resolve({ nextCalled: true, res }),
    );
    setTimeout(() => resolve({ nextCalled: false, res }), 50);
  });
}

describe('agentJsonBodyParser', () => {
  it('accepts a result far beyond the 100 KiB default', async () => {
    const log = 'x'.repeat(3 * 1024 * 1024);
    const req = request(JSON.stringify({ status: 'success', log }));

    const { nextCalled } = await run(req);

    expect(nextCalled).toBe(true);
    expect((req.body as { log: string }).log).toHaveLength(log.length);
  });

  it('answers 413 above its own limit', async () => {
    const big = Buffer.alloc(AGENT_JSON_LIMIT_BYTES + 10, 'a');
    const { nextCalled, res } = await run(request(big));

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(413);
  });

  it('answers 413 when the streamed body outgrows the limit', async () => {
    const req = request('{"a":"' + 'b'.repeat(2000) + '"}', { 'content-length': '' });
    delete req.headers['content-length'];
    req.headers['transfer-encoding'] = 'chunked';

    const { nextCalled, res } = await run(req, response(), 1000);

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(413);
  });

  it('answers 400 for malformed JSON', async () => {
    const { nextCalled, res } = await run(request('{"status":'));

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(400);
  });

  it('leaves a request without an agent credential to the default parser (and its limit)', async () => {
    const req = request(JSON.stringify({ a: 1 }), { authorization: '' });

    const { nextCalled } = await run(req);

    expect(nextCalled).toBe(true);
    expect(req.body).toBeUndefined();
  });

  it('leaves other bodies to the default parser', async () => {
    const req = request('a=b', { 'content-type': 'application/x-www-form-urlencoded' });

    const { nextCalled } = await run(req);

    expect(nextCalled).toBe(true);
    expect(req.body).toBeUndefined();
  });
});

describe('agentJsonBodyParser in front of the Nest default parser', () => {
  it('lets agent results past 100 KiB through while other routes keep the default limit', async () => {
    const adapter = new ExpressAdapter();
    const app = adapter.getInstance();
    app.use(AGENT_CHANNEL_PATH, agentJsonBodyParser());
    // What Nest registers on init(), after main.ts's own middleware.
    adapter.registerParserMiddleware();
    app.post('/api/agents/me/tasks/:id/result', (req: { body: { log: string } }, res: { json: (v: unknown) => void }) =>
      res.json({ logLength: req.body.log.length }),
    );
    app.post('/api/auth/login', (_req: unknown, res: { json: (v: unknown) => void }) => res.json({ ok: true }));
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const body = JSON.stringify({ status: 'success', log: 'x'.repeat(1024 * 1024) });
      const post = (path: string) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer agent-key' },
          body,
        });

      const agentRes = await post('/api/agents/me/tasks/t1/result');
      expect(agentRes.status).toBe(200);
      expect(await agentRes.json()).toEqual({ logLength: 1024 * 1024 });

      const otherRes = await post('/api/auth/login');
      expect(otherRes.status).toBe(413);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('truncateMiddle', () => {
  it('keeps short texts and shortens long ones to the limit, keeping start and end', () => {
    expect(truncateMiddle('short', 100)).toBe('short');
    const long = 'HEAD' + '-'.repeat(10_000) + 'TAIL';
    const out = truncateMiddle(long, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('TAIL')).toBe(true);
    expect(out).toMatch(/… \d+ characters truncated …/);
  });
});
