import { getBackend, requiredJobFields, splitConfig } from './backend-registry';

describe('backend-registry', () => {
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
  });
});
