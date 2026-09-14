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
