import { ResticService, scrubSecretsInText } from './restic.service';
import { ResticContext } from './restic.types';

describe('ResticService read-only commands', () => {
  const ctx = { repository: 'r', password: 'p', env: {}, credentialFiles: [] } as ResticContext;

  function make(stdout: string) {
    const service = new ResticService();
    const run = jest.fn().mockResolvedValue({ code: 0, stdout, stderr: '' });
    (service as unknown as { run: jest.Mock }).run = run;
    return { service, run };
  }

  // A running check or prune holds an exclusive lock; browsing must not fail on it.
  it.each([
    ['snapshots', (s: ResticService) => s.snapshots(ctx), '[]'],
    ['stats', (s: ResticService) => s.stats(ctx), '{}'],
    ['ls', (s: ResticService) => s.ls(ctx, 'abc'), ''],
  ])('runs %s without taking a repository lock', async (_name, call, stdout) => {
    const { service, run } = make(stdout);
    await call(service);
    expect(run.mock.calls[0][1]).toContain('--no-lock');
  });
});

describe('ResticService.restore progress', () => {
  const ctx = { repository: 'r', password: 'p', env: {}, credentialFiles: [] } as ResticContext;

  /** Feeds the given restic JSON lines through `restore` and records the progress. */
  async function restoreWith(lines: object[]) {
    const service = new ResticService();
    (service as unknown as { run: jest.Mock }).run = jest.fn(
      async (_ctx, _args, opts: { onStdoutLine: (l: string) => void }) => {
        for (const l of lines) opts.onStdoutLine(JSON.stringify(l));
        return { code: 0, stdout: '', stderr: '' };
      },
    );
    const progress: Record<string, unknown>[] = [];
    const stats = await service.restore(ctx, 'snap', '/restore', {}, {
      onProgress: (s) => progress.push({ ...s }),
    });
    return { stats, progress };
  }

  it('reports bytes and files, counting skipped ones as done', async () => {
    const { progress } = await restoreWith([
      {
        message_type: 'status',
        percent_done: 0.5,
        total_files: 10,
        files_restored: 3,
        files_skipped: 2,
        total_bytes: 1000,
        bytes_restored: 300,
        bytes_skipped: 200,
      },
    ]);

    expect(progress[0]).toEqual({
      percentDone: 0.5,
      bytesDone: 500,
      totalBytes: 1000,
      filesDone: 5,
      totalFiles: 10,
    });
  });

  it('reads omitted counters as zero', async () => {
    // restic leaves out zero-valued fields, e.g. before the first file is done.
    const { progress } = await restoreWith([
      { message_type: 'status', percent_done: 0, total_files: 4, total_bytes: 80 },
    ]);

    expect(progress[0]).toMatchObject({ bytesDone: 0, filesDone: 0, totalBytes: 80 });
  });

  it('finishes at 100 % with the totals from the summary', async () => {
    const { stats } = await restoreWith([
      { message_type: 'status', percent_done: 0.9, total_bytes: 1000, bytes_restored: 900 },
      {
        message_type: 'summary',
        total_files: 10,
        files_restored: 10,
        total_bytes: 1000,
        bytes_restored: 1000,
      },
    ]);

    expect(stats).toEqual({
      totalFilesProcessed: 10,
      totalBytesProcessed: 1000,
      percentDone: 1,
      bytesDone: 1000,
      totalBytes: 1000,
      filesDone: 10,
      totalFiles: 10,
    });
  });
});

describe('scrubSecretsInText', () => {
  it('redacts credentials embedded in a REST repository URL', () => {
    const line =
      'Fatal: unable to open repository at rest:https://alice:s3cr3t@backup.example.com/repo/';
    const out = scrubSecretsInText(line);
    expect(out).not.toContain('s3cr3t');
    expect(out).not.toContain('alice');
    expect(out).toContain('rest:https://***:***@backup.example.com/repo/');
  });

  it('leaves credential-free output untouched', () => {
    const line = 'processed 1200 files, 3.4 GiB in 0:12';
    expect(scrubSecretsInText(line)).toBe(line);
  });

  it('redacts every occurrence in a line', () => {
    const line = 'a https://u1:p1@h1 b https://u2:p2@h2';
    const out = scrubSecretsInText(line);
    expect(out).not.toMatch(/p1|p2|u1|u2/);
  });
});
