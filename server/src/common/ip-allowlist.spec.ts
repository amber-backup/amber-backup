import { ipAllowed, isValidAllowlistEntry, normalizeIp } from './ip-allowlist';

describe('ip-allowlist', () => {
  it('validates addresses and CIDR ranges', () => {
    for (const ok of ['203.0.113.7', '10.0.0.0/8', '0.0.0.0/0', '2001:db8::1', '2001:db8::/32']) {
      expect(isValidAllowlistEntry(ok)).toBe(true);
    }
    for (const bad of ['', 'example.com', '10.0.0.0/33', '2001:db8::/129', '10.0.0.1/8/1', '10.0.0.0/x', '300.1.1.1']) {
      expect(isValidAllowlistEntry(bad)).toBe(false);
    }
  });

  it('allows everything with an empty list', () => {
    expect(ipAllowed([], '198.51.100.1')).toBe(true);
    expect(ipAllowed([], undefined)).toBe(true);
  });

  it('matches single addresses and ranges', () => {
    const list = ['203.0.113.7', '10.1.0.0/16', '2001:db8::/32'];
    expect(ipAllowed(list, '203.0.113.7')).toBe(true);
    expect(ipAllowed(list, '203.0.113.8')).toBe(false);
    expect(ipAllowed(list, '10.1.255.3')).toBe(true);
    expect(ipAllowed(list, '10.2.0.1')).toBe(false);
    expect(ipAllowed(list, '2001:db8:abcd::5')).toBe(true);
    expect(ipAllowed(list, '2001:db9::5')).toBe(false);
  });

  it('treats IPv4-mapped IPv6 addresses as IPv4', () => {
    expect(normalizeIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(ipAllowed(['10.1.0.0/16'], '::ffff:10.1.2.3')).toBe(true);
  });

  it('rejects unknown or malformed source addresses when a list is set', () => {
    expect(ipAllowed(['10.0.0.0/8'], undefined)).toBe(false);
    expect(ipAllowed(['10.0.0.0/8'], 'garbage')).toBe(false);
  });
});
