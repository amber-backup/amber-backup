import { lookup } from 'dns/promises';
import { isIP } from 'net';

/**
 * SSRF guard for URLs/hosts the server itself connects to on user-supplied
 * input (notification webhooks/SMTP, target reachability probes).
 *
 * Backup targets and self-hosted notification servers legitimately live on
 * private networks, so RFC1918 ranges are NOT blocked — that would break real
 * deployments. What is blocked is the set of addresses that are never a valid
 * external target but are the high-value SSRF destinations: loopback (reach the
 * server's own localhost-only services), link-local incl. the cloud metadata
 * endpoint 169.254.169.254, and the unspecified address.
 *
 * Note: this resolves-then-checks, so a DNS-rebinding attacker who flips the
 * record between this check and the connection is a residual risk; the common
 * metadata/localhost SSRF vectors are closed.
 */
export class BlockedAddressError extends Error {
  constructor(host: string) {
    super(
      `Refusing to connect to "${host}": it resolves to a loopback, ` +
        `link-local or unspecified address`,
    );
    this.name = 'BlockedAddressError';
  }
}

function ipv4Blocked(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 0) return true; // "this" network 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
  return false;
}

function ipv6Blocked(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true; // loopback / unspecified
  if (s.startsWith('fe80')) return true; // link-local
  if (s.startsWith('fec0')) return true; // deprecated site-local
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  return false;
}

function addressBlocked(address: string, family: number): boolean {
  return family === 6 ? ipv6Blocked(address) : ipv4Blocked(address);
}

/** Throws BlockedAddressError if the host resolves to a blocked address. */
export async function assertSafeHost(host: string): Promise<void> {
  const clean = host.replace(/^\[|\]$/g, '');
  const literal = isIP(clean);
  const addresses = literal
    ? [{ address: clean, family: literal }]
    : await lookup(clean, { all: true }).catch(() => {
        // A name that cannot be resolved is not an SSRF risk; let the actual
        // connection attempt surface the DNS error normally.
        return [] as { address: string; family: number }[];
      });
  for (const a of addresses) {
    if (addressBlocked(a.address, a.family)) throw new BlockedAddressError(host);
  }
}

/**
 * Validates a URL for server-side fetching: only http(s), and the host must not
 * resolve to a blocked address. Returns the parsed URL.
 */
export async function assertSafeFetchUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed');
  }
  await assertSafeHost(url.hostname);
  return url;
}
