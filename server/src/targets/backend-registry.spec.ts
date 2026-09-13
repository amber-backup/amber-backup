import {
  assertSafeSftpConfig,
  getBackend,
  overridableFields,
  requiredJobFields,
  splitConfig,
} from './backend-registry';

describe('backend-registry', () => {
  describe('sftp', () => {
    const build = (config: Record<string, unknown>) =>
      getBackend('sftp').build(config, { privateKey: 'KEY' }, { path: '/b' });

    it('builds an ssh sftp.command for a plain host/user', () => {
      const res = build({ host: 'backup.example.com', user: 'restic', port: '22' });
      expect(res.repository).toBe('sftp:restic@backup.example.com:/b');
      expect(res.extraArgs).toEqual([
        '-o',
        expect.stringContaining('sftp.command=ssh restic@backup.example.com -p 22'),
      ]);
    });

    it('accepts a bracketed IPv6 host', () => {
      expect(() => assertSafeSftpConfig({ host: '[2001:db8::1]', user: 'r' })).not.toThrow();
    });

    it.each([
      { host: '127.0.0.1 -oProxyCommand=touch${IFS}/pwn', user: 'r' },
      { host: 'ok', user: '-oProxyCommand=x' },
      { host: 'has space', user: 'r' },
      { host: '-leadingdash', user: 'r' },
      { host: 'ok', user: 'r', port: '22; rm -rf /' },
    ])('rejects ssh-option injection via %o', (config) => {
      expect(() => assertSafeSftpConfig(config)).toThrow();
      expect(() => build(config)).toThrow();
    });
  });

  describe('rest', () => {
    const build = (
      config: Record<string, unknown>,
      credentials: Record<string, string> = {},
      repoConfig: Record<string, unknown> = {},
    ) => getBackend('rest').build(config, credentials, repoConfig).repository;

    it('appends the repository name to the server URL', () => {
      expect(build({ url: 'https://backup.example.com' }, {}, { path: 'my_backup_repo' })).toBe(
        'rest:https://backup.example.com/my_backup_repo/',
      );
    });

    it('keeps the server root when no repository name is given', () => {
      expect(build({ url: 'https://backup.example.com' })).toBe('rest:https://backup.example.com/');
    });

    it('normalises slashes around the URL and the repository name', () => {
      expect(build({ url: 'https://backup.example.com/' }, {}, { path: '/my_backup_repo/' })).toBe(
        'rest:https://backup.example.com/my_backup_repo/',
      );
    });

    it('preserves an explicit http scheme and a custom port', () => {
      expect(build({ url: 'http://host:8000' }, {}, { path: 'repo' })).toBe(
        'rest:http://host:8000/repo/',
      );
    });

    it('embeds url-encoded credentials before the host', () => {
      expect(
        build({ url: 'https://host:8000' }, { username: 'us er', password: 'p@ss' }, { path: 'repo' }),
      ).toBe('rest:https://us%20er:p%40ss@host:8000/repo/');
    });

    it('exposes the repository name as an optional job-scoped field', () => {
      expect(requiredJobFields('rest')).toEqual([]);
      expect(splitConfig('rest', { url: 'https://host', path: 'repo' }, 'job')).toEqual({
        config: { path: 'repo' },
        credentials: {},
      });
    });

    it('declares username and password as per-job overridable', () => {
      expect(overridableFields('rest')).toEqual(['username', 'password']);
    });
  });

  describe('overridable fields', () => {
    it('are collected as credentials at job scope', () => {
      expect(
        splitConfig('rest', { username: 'u', password: 'p', path: 'repo' }, 'job'),
      ).toEqual({ config: { path: 'repo' }, credentials: { username: 'u', password: 'p' } });
    });

    it('still belong to the connection at target scope', () => {
      expect(
        splitConfig('rest', { url: 'https://host', username: 'u', password: 'p' }, 'target'),
      ).toEqual({ config: { url: 'https://host' }, credentials: { username: 'u', password: 'p' } });
    });

    it('are empty for a backend that declares none', () => {
      expect(overridableFields('s3')).toEqual([]);
      expect(splitConfig('s3', { accessKeyId: 'a', bucket: 'b' }, 'job')).toEqual({
        config: { bucket: 'b' },
        credentials: {},
      });
    });
  });
});
