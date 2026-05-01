/**
 * SSRF (Server-Side Request Forgery) protection for URL unfurling.
 *
 * Validates user-supplied URLs before they are fetched server-side.
 * Blocks private/reserved IP ranges, non-HTTP protocols, and domain
 * allow/block lists.
 *
 * DNS rebinding protection is handled by {@link resolveAndValidate}, which
 * resolves the hostname to all its A/AAAA records before each fetch hop and
 * rejects any that resolve to private/reserved ranges. This prevents attacks
 * where a hostname initially resolves to a public IP but switches to a private
 * one between the SSRF check and the actual connection.
 *
 * @module
 */

/** Result of URL validation — either valid with a parsed URL, or invalid with a reason. */
export type ValidateUrlResult = { valid: true; url: URL } | { valid: false; reason: string };

/**
 * Check whether an IP address string falls within private or reserved ranges.
 *
 * Covers: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 * 0.0.0.0/8, 169.254.0.0/16, ::1, fc00::/7, fe80::/10.
 *
 * @param ip - The IP address to check (IPv4 or IPv6).
 * @returns `true` if the IP is in a private/reserved range.
 */
export function isPrivateIp(ip: string): boolean {
  // IPv6 loopback
  if (ip === '::1' || ip === '::') return true;

  // IPv6 private ranges
  const lowerIp = ip.toLowerCase();
  if (lowerIp.startsWith('fc') || lowerIp.startsWith('fd')) return true; // fc00::/7
  if (
    lowerIp.startsWith('fe8') ||
    lowerIp.startsWith('fe9') ||
    lowerIp.startsWith('fea') ||
    lowerIp.startsWith('feb')
  )
    return true; // fe80::/10

  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const ipv4 = v4Mapped ? v4Mapped[1] : ip;

  // IPv4 check
  const parts = ipv4.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map(Number);
  if (octets.some(o => Number.isNaN(o) || o < 0 || o > 255)) return false;

  const [a, b] = octets;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 127.0.0.0/8
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;

  return false;
}

/**
 * Validate a user-supplied URL for safe server-side fetching.
 *
 * Ensures the URL uses http/https, is not targeting private/reserved IPs,
 * and passes domain allow/block list checks.
 *
 * @param url - The raw URL string to validate.
 * @param config - Domain restriction configuration.
 * @param config.allowedDomains - If non-empty, only these domains are permitted.
 * @param config.blockedDomains - These domains are always rejected.
 * @returns A discriminated union: `{ valid: true; url: URL }` or `{ valid: false; reason: string }`.
 */
export function validateUrl(
  url: string,
  config: { allowedDomains?: string[]; blockedDomains?: string[] },
): ValidateUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // URL constructor failed — treat as invalid
    return { valid: false, reason: 'Invalid URL format' };
  }

  // Protocol check
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: `Disallowed protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block obvious private hostnames
  if (hostname === 'localhost' || hostname === '[::1]') {
    return { valid: false, reason: 'Private/reserved hostname' };
  }

  // Check if hostname is an IP literal
  // Strip brackets for IPv6
  const bareHost =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (isPrivateIp(bareHost)) {
    return { valid: false, reason: 'Private/reserved IP address' };
  }

  // Domain allow list (if non-empty, only these pass)
  const allowed = config.allowedDomains ?? [];
  if (allowed.length > 0) {
    const isAllowed = allowed.some(d => {
      const domain = d.toLowerCase();
      return hostname === domain || hostname.endsWith('.' + domain);
    });
    if (!isAllowed) {
      return { valid: false, reason: `Domain not in allow list: ${hostname}` };
    }
  }

  // Domain block list
  const blocked = config.blockedDomains ?? [];
  const isBlocked = blocked.some(d => {
    const domain = d.toLowerCase();
    return hostname === domain || hostname.endsWith('.' + domain);
  });
  if (isBlocked) {
    return { valid: false, reason: `Domain is blocked: ${hostname}` };
  }

  return { valid: true, url: parsed };
}

/** Result of async hostname validation. */
export type ResolveValidateResult = { ok: true } | { ok: false; reason: string };

/**
 * Resolve a hostname via DNS and verify that none of the resolved addresses
 * fall within private/reserved IP ranges.
 *
 * This is the DNS-rebinding protection layer. Call this before every fetch hop
 * (initial request and each redirect) to ensure the hostname has not been
 * redirected to a private address since the initial SSRF string check.
 *
 * @param hostname - The bare hostname to resolve (no brackets, no port).
 * @returns `{ ok: true }` if all resolved IPs are public, or
 *   `{ ok: false; reason }` if DNS fails or any IP is private.
 */
export async function resolveAndValidate(hostname: string): Promise<ResolveValidateResult> {
  // Localhost variants not caught by isPrivateIp string match
  if (hostname === 'localhost' || hostname === '[::1]') {
    return { ok: false, reason: `Private/reserved hostname: ${hostname}` };
  }

  let addresses: { address: string }[];
  try {
    if (typeof globalThis.Bun !== 'undefined' && globalThis.Bun.dns) {
      addresses = await globalThis.Bun.dns.lookup(hostname);
    } else {
      const dns = await import('node:dns/promises');
      const results = await dns.lookup(hostname, { all: true });
      addresses = results.map(r => ({ address: r.address }));
    }
  } catch {
    // DNS lookup threw — report resolution failure
    return { ok: false, reason: `DNS resolution failed for: ${hostname}` };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: `No DNS records found for: ${hostname}` };
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      return { ok: false, reason: `Hostname resolves to private IP: ${address}` };
    }
  }

  return { ok: true };
}
