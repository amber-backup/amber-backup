import { assertSafeFetchUrl, assertSafeHost, BlockedAddressError } from './net-guard';

describe('net-guard (SSRF)', () => {
  it('blocks loopback, link-local (metadata) and unspecified IP literals', async () => {
    for (const host of ['127.0.0.1', '169.254.169.254', '0.0.0.0', '::1']) {
      await expect(assertSafeHost(host)).rejects.toBeInstanceOf(BlockedAddressError);
    }
  });

  it('blocks IPv4-mapped IPv6 loopback', async () => {
    await expect(assertSafeHost('::ffff:127.0.0.1')).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
  });

  it('allows RFC1918 private addresses (legitimate internal backup targets)', async () => {
    for (const host of ['10.0.0.5', '192.168.1.10', '172.16.4.4']) {
      await expect(assertSafeHost(host)).resolves.toBeUndefined();
    }
  });

  it('rejects non-http(s) schemes', async () => {
    await expect(assertSafeFetchUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(assertSafeFetchUrl('gopher://127.0.0.1')).rejects.toThrow();
  });

  it('blocks a metadata URL by host', async () => {
    await expect(
      assertSafeFetchUrl('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });
});
