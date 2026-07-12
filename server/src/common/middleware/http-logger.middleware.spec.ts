import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { httpLogger } from './http-logger.middleware';

/** Minimal Express req/res doubles that capture the `finish` handler. */
function makeReqRes(method: string, url: string) {
  const req = { method, originalUrl: url } as unknown as Request;
  let finish: () => void = () => undefined;
  const headers: Record<string, string | number> = {};
  const res = {
    statusCode: 200,
    on: (event: string, cb: () => void) => {
      if (event === 'finish') finish = cb;
    },
    getHeader: (name: string) => headers[name.toLowerCase()],
  } as unknown as Response;
  const setHeader = (name: string, value: string | number) => {
    headers[name.toLowerCase()] = value;
  };
  return { req, res, triggerFinish: () => finish(), setHeader };
}

describe('httpLogger', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let next: NextFunction;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    next = jest.fn();
  });

  afterEach(() => jest.restoreAllMocks());

  it('calls next() and does not log until the response finishes', () => {
    const { req, res } = makeReqRes('GET', '/api/jobs');
    httpLogger(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('logs a 2xx request at info level', () => {
    const { req, res, triggerFinish } = makeReqRes('GET', '/api/jobs');
    httpLogger(req, res, next);
    triggerFinish();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/^GET \/api\/jobs 200 \d+ms$/);
  });

  it('logs 4xx at warn and 5xx at error', () => {
    const a = makeReqRes('POST', '/api/auth/login');
    (a.res as { statusCode: number }).statusCode = 401;
    httpLogger(a.req, a.res, next);
    a.triggerFinish();
    expect(warn).toHaveBeenCalledTimes(1);

    const b = makeReqRes('GET', '/api/runs');
    (b.res as { statusCode: number }).statusCode = 500;
    httpLogger(b.req, b.res, next);
    b.triggerFinish();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('includes the response size when content-length is set', () => {
    const { req, res, triggerFinish, setHeader } = makeReqRes('GET', '/api/agents');
    setHeader('content-length', 1234);
    httpLogger(req, res, next);
    triggerFinish();
    expect(log.mock.calls[0][0]).toMatch(/^GET \/api\/agents 200 \d+ms 1234b$/);
  });

  it('redacts sensitive query parameters', () => {
    const { req, res, triggerFinish } = makeReqRes(
      'GET',
      '/api/auth/oidc/callback?code=abcSECRET&state=xyzSECRET&next=/dashboard',
    );
    httpLogger(req, res, next);
    triggerFinish();
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain('code=***');
    expect(line).toContain('state=***');
    expect(line).not.toContain('SECRET');
    expect(line).toContain('next=/dashboard');
  });
});
