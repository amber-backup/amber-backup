import { BlockList, isIP } from 'net';

/**
 * IP allowlists (per agent, and for administrators): entries are single
 * addresses (`203.0.113.7`, `2001:db8::1`) or CIDR ranges (`10.0.0.0/8`,
 * `2001:db8::/32`).
 */

type Entry = { address: string; prefix: number | null; family: 'ipv4' | 'ipv6' };

/** Strips the IPv4-mapped IPv6 prefix Node reports on dual-stack sockets. */
export function normalizeIp(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return mapped ? mapped[1] : ip;
}

function parseEntry(raw: string): Entry | null {
  const [address, prefixText, ...rest] = raw.trim().split('/');
  if (rest.length > 0) return null;
  const version = isIP(address);
  if (!version) return null;
  const family = version === 4 ? 'ipv4' : 'ipv6';
  if (prefixText === undefined) return { address, prefix: null, family };
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > (version === 4 ? 32 : 128)) return null;
  return { address, prefix, family };
}

/** True if `raw` is a valid IP address or CIDR range. */
export function isValidAllowlistEntry(raw: string): boolean {
  return parseEntry(raw) !== null;
}

/**
 * True if `ip` is permitted by `allowlist`. An empty allowlist permits every
 * address; a request without a known address is only permitted then.
 */
export function ipAllowed(allowlist: string[], ip: string | undefined): boolean {
  if (allowlist.length === 0) return true;
  if (!ip) return false;
  const addr = normalizeIp(ip);
  const version = isIP(addr);
  if (!version) return false;

  const list = new BlockList();
  for (const raw of allowlist) {
    const entry = parseEntry(raw);
    if (!entry) continue;
    if (entry.prefix === null) list.addAddress(entry.address, entry.family);
    else list.addSubnet(entry.address, entry.prefix, entry.family);
  }
  return list.check(addr, version === 4 ? 'ipv4' : 'ipv6');
}
