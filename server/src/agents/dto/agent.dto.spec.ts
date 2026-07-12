import { ValidationPipe } from '@nestjs/common';
import { TaskProgressDto } from './agent.dto';

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
