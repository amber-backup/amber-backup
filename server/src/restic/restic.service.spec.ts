import { scrubSecretsInText } from './restic.service';

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
