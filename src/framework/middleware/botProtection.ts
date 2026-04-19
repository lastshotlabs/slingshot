import type { MiddlewareHandler } from 'hono';
import { getClientIp } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// CIDR helpers (IPv4 only; IPv6 exact-match supported)
// ---------------------------------------------------------------------------

/**
 * Convert a dotted-decimal IPv4 string to an unsigned 32-bit integer.
 *
 * @param ip - Dotted-decimal IPv4 address (e.g. `"192.168.1.1"`).
 * @returns The address as an unsigned 32-bit integer.
 * @throws {Error} If `ip` is not a valid four-octet IPv4 address.
 */
function ipv4ToUint32(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`[botProtection] Invalid IPv4 address: "${ip}"`);
  const octets = parts.map(Number);
  if (octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) {
    throw new Error(`[botProtection] Invalid IPv4 address: "${ip}"`);
  }
  const [a, b, c, d] = octets;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/**
 * Test whether a dotted-decimal IPv4 address falls inside an IPv4 CIDR range.
 *
 * If `cidr` contains no `/` it is treated as a /32 (exact match).
 *
 * @param cidr - An IPv4 CIDR range such as `"198.51.100.0/24"`, or a bare IPv4
 *   address for an exact-match test.
 * @param ip - The candidate IPv4 address in dotted-decimal notation.
 * @returns `true` when `ip` falls inside `cidr`; `false` otherwise.
 */
function cidrMatchesIpv4(cidr: string, ip: string): boolean {
  const slash = cidr.indexOf('/');
  const network = slash === -1 ? cidr : cidr.slice(0, slash);
  const prefixLen = slash === -1 ? 32 : parseInt(cidr.slice(slash + 1), 10);
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ipv4ToUint32(network) & mask) === (ipv4ToUint32(ip) & mask);
}

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Normalize an IP address string for comparison.
 *
 * Strips the IPv4-mapped IPv6 prefix (`::ffff:`) so that the address
 * `::ffff:1.2.3.4` is treated identically to `1.2.3.4`.
 *
 * @param ip - Raw IP address string as provided by the request context.
 * @returns The normalized IP string (IPv4-mapped prefix removed if present).
 */
function normalizeIp(ip: string): string {
  // Strip IPv4-mapped IPv6 prefix (::ffff:1.2.3.4)
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

/**
 * Determine whether an IP address is covered by any entry in the block list.
 *
 * IPv4 addresses (including those previously IPv4-mapped) are matched against
 * CIDR ranges via {@link cidrMatchesIpv4}.  IPv6 addresses are matched by
 * exact string equality only (CIDR support is planned for a future release).
 *
 * @param ip - The raw client IP string (will be normalized internally).
 * @param blockList - Array of IPv4 CIDR ranges, bare IPv4 addresses, or exact
 *   IPv6 addresses to block.
 * @returns `true` when `ip` matches at least one entry; `false` otherwise.
 */
function isBlocked(ip: string, blockList: string[]): boolean {
  const normalized = normalizeIp(ip);
  const isV4 = IPV4_RE.test(normalized);

  for (const entry of blockList) {
    if (isV4) {
      if (cidrMatchesIpv4(entry, normalized)) return true;
    } else {
      // IPv6: exact match only (CIDR support is v2)
      if (entry === normalized) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export interface BotProtectionOptions {
  /**
   * List of IPv4 CIDRs (e.g. "198.51.100.0/24"), IPv4 exact addresses,
   * or IPv6 exact addresses to block with a 403.
   */
  blockList?: string[];
}

/**
 * Hono middleware that blocks requests from known-bad IP addresses.
 *
 * Block-list entries are validated eagerly at construction time (startup), so
 * misconfigured CIDR strings cause an immediate error rather than a silent
 * miss at request time.
 *
 * If `blockList` is empty, the middleware is a no-op passthrough.
 *
 * @param options - Configuration object.  See {@link BotProtectionOptions}.
 * @returns A Hono `MiddlewareHandler` that responds with `403 Forbidden` for
 *   any request whose resolved client IP is covered by `blockList`.
 *
 * @example
 * ```ts
 * app.use(botProtection({
 *   blockList: [
 *     '198.51.100.0/24', // CIDR range
 *     '203.0.113.42',    // single IPv4
 *     '2001:db8::1',     // exact IPv6
 *   ],
 * }));
 * ```
 */
export const botProtection = ({ blockList = [] }: BotProtectionOptions): MiddlewareHandler => {
  if (blockList.length === 0) return (_c, next) => next();

  // Validate blockList entries at startup — fail fast on misconfigured CIDRs rather
  // than silently mismatching at request time.
  for (const entry of blockList) {
    const network = entry.includes('/') ? entry.slice(0, entry.indexOf('/')) : entry;
    if (!network.includes(':') && network.includes('.')) {
      ipv4ToUint32(network); // throws on invalid octet values and malformed dotted IPv4 strings
    }
  }

  return async (c, next) => {
    const ip = getClientIp(c);

    if (ip !== 'unknown' && isBlocked(ip, blockList)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await next();
  };
};
