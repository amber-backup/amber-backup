import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  OUTPUT_TAIL_BYTES,
  ResticService,
  TailBuffer,
  repositoryMissingMessage,
} from './restic.service';
import { ResticContext } from './restic.types';

const ctx: ResticContext = {
  repository: '/mnt/backup/repo',
  password: 'p',
  env: {},
  credentialFiles: [],
};

describe('TailBuffer', () => {
  it('keeps only the last bytes and says how much it dropped', () => {
    const buf = new TailBuffer(10);
    for (let i = 0; i < 100; i++) buf.append('abcdefghij');
    buf.append('0123456789');
    expect(buf.toString()).toBe('… 1000 bytes truncated …\n0123456789');
  });

  it('returns short output unchanged', () => {
    const buf = new TailBuffer(10);
    buf.append('short');
    expect(buf.toString()).toBe('short');
  });
});

/**
 * Runs the real process plumbing against a fake `restic` (a shell script), so
 * buffering and the environment are tested end to end.
 */
describe('ResticService process handling', () => {
  let dir: string;
  const prevBinary = process.env.RESTIC_BINARY;
  const prevCache = process.env.RESTIC_CACHE_DIR;

  async function fakeRestic(script: string): Promise<ResticService> {
    const bin = path.join(dir, 'restic');
    await fs.writeFile(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    process.env.RESTIC_BINARY = bin;
    process.env.RESTIC_CACHE_DIR = path.join(dir, 'cache');
    return new ResticService();
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-restic-spec-'));
  });
  afterEach(async () => {
    if (prevBinary === undefined) delete process.env.RESTIC_BINARY;
    else process.env.RESTIC_BINARY = prevBinary;
    if (prevCache === undefined) delete process.env.RESTIC_CACHE_DIR;
    else process.env.RESTIC_CACHE_DIR = prevCache;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('streams a backup without keeping its whole output, at 1 status line per second', async () => {
    // ~300 KiB of status lines, then the summary; FPS is echoed on stderr.
    const service = await fakeRestic(`
echo "fps=$RESTIC_PROGRESS_FPS" >&2
i=0
while [ $i -lt 3000 ]; do
  echo '{"message_type":"status","percent_done":0.5,"current_files":["/data/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}'
  i=$((i+1))
done
echo '{"message_type":"summary","snapshot_id":"abc123","files_new":1}'
`);
    const run = jest.spyOn(service as never, 'spawn' as never) as jest.SpyInstance;
    const logs: string[] = [];
    const progress: unknown[] = [];

    const result = await service.backup(ctx, ['/data'], {}, {
      onLog: (l) => logs.push(l),
      onProgress: (s) => progress.push(s),
    });

    expect(result.snapshotId).toBe('abc123');
    expect(progress.length).toBe(3001);
    expect(logs).toContain('fps=1');
    const outcome = await (run.mock.results[0].value as Promise<{ stdout: string }>);
    expect(outcome.stdout.length).toBeLessThan(OUTPUT_TAIL_BYTES + 100);
  });

  it('keeps only the tail of a huge stderr in the error', async () => {
    const service = await fakeRestic(`
i=0
while [ $i -lt 4000 ]; do
  echo "error: open /data/file-$i: permission denied, padding padding padding padding" >&2
  i=$((i+1))
done
echo "Fatal: the last line" >&2
exit 1
`);
    const err = await service.backup(ctx, ['/data'], {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message.length).toBeLessThan(OUTPUT_TAIL_BYTES + 100);
    expect(message).toContain('bytes truncated');
    expect(message).toContain('Fatal: the last line');
  });

  describe('ensureInitialized', () => {
    it('initialises a repository restic reports missing (exit 10) that never existed', async () => {
      const service = await fakeRestic(`
if [ "$1" = "cat" ]; then echo "Fatal: repository does not exist" >&2; exit 10; fi
if [ "$1" = "init" ]; then echo "created restic repository" ; exit 0; fi
exit 99
`);
      const logs: string[] = [];
      await expect(
        service.ensureInitialized(ctx, { repoInitialized: false, onLog: (l) => logs.push(l) }),
      ).resolves.toEqual({ initialized: true });
      expect(logs).toContain('[cat config] Fatal: repository does not exist');
      expect(logs).toContain('[init] created restic repository');
    });

    it('refuses to re-create a repository that already held backups', async () => {
      const service = await fakeRestic(`
if [ "$1" = "cat" ]; then echo "Fatal: repository does not exist" >&2; exit 10; fi
touch "${'$'}{0%/*}/init-ran"; exit 0
`);
      await expect(
        service.ensureInitialized(ctx, { repoInitialized: true }),
      ).rejects.toThrow(repositoryMissingMessage(ctx.repository));
      await expect(fs.access(path.join(dir, 'init-ran'))).rejects.toThrow();
    });

    it('never initialises on any other cat config failure and reports its stderr', async () => {
      const service = await fakeRestic(`
if [ "$1" = "cat" ]; then echo "Fatal: wrong password or no key found" >&2; exit 12; fi
touch "${'$'}{0%/*}/init-ran"; exit 0
`);
      await expect(service.ensureInitialized(ctx)).rejects.toThrow(
        /exit 12.*wrong password or no key found/,
      );
      await expect(fs.access(path.join(dir, 'init-ran'))).rejects.toThrow();
    });

    it('does nothing for an existing repository', async () => {
      const service = await fakeRestic(`
if [ "$1" = "cat" ]; then exit 0; fi
exit 99
`);
      await expect(service.ensureInitialized(ctx)).resolves.toEqual({ initialized: false });
    });
  });

  describe('testConnection', () => {
    it('reports a cat config failure other than "does not exist" without init', async () => {
      const service = await fakeRestic(`
if [ "$1" = "cat" ]; then echo "Fatal: unable to open config file: permission denied" >&2; exit 1; fi
exit 0
`);
      await expect(service.testConnection(ctx)).resolves.toEqual({
        ok: false,
        initialized: false,
        message: 'Fatal: unable to open config file: permission denied',
      });
    });

    it('initialises a repository that does not exist yet', async () => {
      const service = await fakeRestic(`
if [ "$1" = "cat" ]; then exit 10; fi
if [ "$1" = "init" ]; then exit 0; fi
exit 99
`);
      await expect(service.testConnection(ctx)).resolves.toMatchObject({
        ok: true,
        initialized: true,
      });
    });
  });
});
