import { UpdateCheckService } from './update-check.service';

describe('UpdateCheckService', () => {
  const originalFetch = global.fetch;
  let service: UpdateCheckService;

  function mockRelease(body: unknown, status = 200): jest.Mock {
    const fn = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  beforeEach(() => {
    delete process.env.UPDATE_CHECK_ENABLED;
    service = new UpdateCheckService();
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.UPDATE_CHECK_ENABLED;
  });

  it('starts with an unknown status', () => {
    expect(service.getStatus()).toEqual({
      latestVersion: null,
      releaseUrl: null,
      checkedAt: null,
    });
  });

  it('caches the latest release version and page', async () => {
    const url =
      'https://github.com/amber-backup/amber-backup/releases/tag/v1.29.0';
    mockRelease({ tag_name: 'v1.29.0', html_url: url });

    await service.check();

    const status = service.getStatus();
    expect(status.latestVersion).toBe('1.29.0');
    expect(status.releaseUrl).toBe(url);
    expect(status.checkedAt).not.toBeNull();
  });

  it('never links to a page outside the release repository', async () => {
    mockRelease({ tag_name: 'v1.29.0', html_url: 'https://evil.example/x' });

    await service.check();

    expect(service.getStatus().releaseUrl).toBe(
      'https://github.com/amber-backup/amber-backup/releases/tag/v1.29.0',
    );
  });

  it('keeps the previous status when a check fails', async () => {
    mockRelease({ tag_name: 'v1.29.0', html_url: null });
    await service.check();

    mockRelease({ message: 'rate limited' }, 403);
    await service.check();
    mockRelease({ tag_name: 'nightly' });
    await service.check();

    expect(service.getStatus().latestVersion).toBe('1.29.0');
  });

  it('does not contact GitHub when disabled', async () => {
    process.env.UPDATE_CHECK_ENABLED = 'false';
    const fetchMock = mockRelease({ tag_name: 'v1.29.0' });

    await service.check();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(service.getStatus().latestVersion).toBeNull();
  });
});
