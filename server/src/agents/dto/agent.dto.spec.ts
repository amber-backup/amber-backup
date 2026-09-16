import { ValidationPipe } from '@nestjs/common';
import { TaskProgressDto, UpdateAgentDto } from './agent.dto';

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
