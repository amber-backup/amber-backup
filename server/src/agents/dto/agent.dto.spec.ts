import { ValidationPipe } from '@nestjs/common';
import {
  PollDto,
  RESULT_ERROR_MAX,
  RESULT_LOG_MAX,
  TaskProgressDto,
  TaskResultDto,
  UpdateAgentDto,
} from './agent.dto';

// Mirrors the global pipe configured in main.ts.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const meta = { type: 'body' as const, metatype: TaskProgressDto, data: '' };

describe('TaskProgressDto (agent progress)', () => {
  it('accepts a stats object and keeps its fields', async () => {
    const body = {
      stats: {
        percentDone: 0.42,
        bytesDone: 12345,
        totalBytes: 67890,
        filesDone: 3,
        totalFiles: 10,
      },
    };
    const out = (await pipe.transform(body, meta)) as TaskProgressDto;
    // Regression guard: undecorated `stats` was stripped/rejected by
    // forbidNonWhitelisted, silently 400-ing every agent progress update.
    expect(out.stats).toEqual(body.stats);
  });

  it('rejects a non-object stats value', async () => {
    await expect(
      pipe.transform({ stats: 'nope' }, meta),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe('UpdateAgentDto (labels + IP allowlist)', () => {
  const updateMeta = { type: 'body' as const, metatype: UpdateAgentDto, data: '' };

  it('accepts labels and addresses/CIDR ranges', async () => {
    const body = { labels: ['prod', 'eu'], allowedIps: ['203.0.113.7', '10.0.0.0/8', '2001:db8::/32'] };
    const out = (await pipe.transform(body, updateMeta)) as UpdateAgentDto;
    expect(out.labels).toEqual(body.labels);
    expect(out.allowedIps).toEqual(body.allowedIps);
  });

  it('accepts an empty allowlist', async () => {
    const out = (await pipe.transform({ allowedIps: [] }, updateMeta)) as UpdateAgentDto;
    expect(out.allowedIps).toEqual([]);
  });

  it('rejects an entry that is not an address or range', async () => {
    await expect(
      pipe.transform({ allowedIps: ['10.0.0.0/8', 'example.com'] }, updateMeta),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe('TaskResultDto (over-long texts)', () => {
  const resultMeta = { type: 'body' as const, metatype: TaskResultDto, data: '' };

  it('shortens an over-long log and error instead of rejecting the result', async () => {
    const log = 'first line\n' + 'x'.repeat(300_000) + '\nFatal: the final error';
    const error = 'e'.repeat(25_000) + ' the cause';
    const out = (await pipe.transform(
      { status: 'success', snapshotId: 'snap-1', log, error, repoStatsError: error },
      resultMeta,
    )) as TaskResultDto;

    expect(out.status).toBe('success');
    expect(out.snapshotId).toBe('snap-1');
    expect(out.log!.length).toBeLessThanOrEqual(RESULT_LOG_MAX);
    expect(out.log!.startsWith('first line')).toBe(true);
    expect(out.log!.endsWith('Fatal: the final error')).toBe(true);
    expect(out.log).toContain('characters truncated');
    expect(out.error!.length).toBeLessThanOrEqual(RESULT_ERROR_MAX);
    expect(out.error!.endsWith('the cause')).toBe(true);
    expect(out.repoStatsError!.length).toBeLessThanOrEqual(RESULT_ERROR_MAX);
  });

  it('shortens a long prune log too', async () => {
    const out = (await pipe.transform(
      {
        status: 'success',
        prune: {
          status: 'success',
          startedAt: '2026-11-01T10:00:00Z',
          finishedAt: '2026-11-01T10:01:00Z',
          log: 'p'.repeat(250_000),
        },
      },
      resultMeta,
    )) as TaskResultDto;
    expect(out.prune!.log!.length).toBeLessThanOrEqual(RESULT_LOG_MAX);
  });

  it('keeps texts within the limit unchanged', async () => {
    const out = (await pipe.transform(
      { status: 'failed', error: 'boom', log: 'a\nb' },
      resultMeta,
    )) as TaskResultDto;
    expect(out.error).toBe('boom');
    expect(out.log).toBe('a\nb');
  });
});

describe('PollDto (task list)', () => {
  const pollMeta = { type: 'body' as const, metatype: PollDto, data: '' };

  it('accepts the ids of the tasks the agent holds, also an empty list', async () => {
    const ids = ['0b6f4a52-1c3e-4d5f-8a9b-0c1d2e3f4a5b', 'stats-repo-1'];
    const out = (await pipe.transform({ runningTaskIds: ids }, pollMeta)) as PollDto;
    expect(out.runningTaskIds).toEqual(ids);
    const idle = (await pipe.transform({ runningTaskIds: [] }, pollMeta)) as PollDto;
    expect(idle.runningTaskIds).toEqual([]);
  });

  it('rejects a task list that is not a list of strings', async () => {
    await expect(pipe.transform({ runningTaskIds: [1, 2] }, pollMeta)).rejects.toBeInstanceOf(
      Error,
    );
  });
});
