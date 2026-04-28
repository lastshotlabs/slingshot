/**
 * SSRF protection for webhook target URLs.
 *
 * Rejects URLs that target private infrastructure:
 * - Non-HTTP/HTTPS schemes
 * - Loopback hostnames (`localhost`, `127.x.x.x`, `::1`)
 * - Link-local IPv4 (`169.254.x.x`, includes AWS metadata `169.254.169.254`)
 * - Link-local IPv6 (`fe80::/10`)
 * - Unique-local IPv6 (`fc00::/7`)
 * - IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is unwrapped and re-checked
 * - Private IPv4 ranges (`10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`)
 * - Carrier-grade NAT (`100.64.0.0/10`)
 * - Multicast (`224.0.0.0/4`, `ff00::/8`)
 * - The unspecified address (`0.0.0.0`, `::`)
 *
 * DNS resolution is intentionally not performed here. Hostname-based checks
 * catch the most common attack vectors without the latency hit. For full DNS
 * rebinding defense, callers should re-resolve the host at dispatch time and
 * pass each resolved IP through {@link validateWebhookIp}.
 *
 * @param url - The candidate webhook target URL string.
 * @throws {Error} With a descriptive message when the URL is rejected.
 */
export function validateWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: "${url}" could not be parsed`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid webhook URL: scheme "${parsed.protocol.replace(/:$/, '')}" is not allowed; use http or https`,
    );
  }

  const host = parsed.hostname.toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('Invalid webhook URL: "localhost" is not allowed (loopback address)');
  }

  // Strip IPv6 brackets for range checks
  const ip = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  validateWebhookIp(ip);
}

/**
 * Validate a literal IP address string against the same blocklist as
 * {@link validateWebhookUrl}. Use this after DNS resolution to defend against
 * DNS rebinding (where the hostname resolves to a public IP at registration
 * time but a private IP at dispatch time).
 *
 * Accepts both IPv4 dotted-quad and IPv6 textual forms. Hostnames are passed
 * through unchanged — only address literals are inspected.
 *
 * @param ip - The IP address (or hostname) to validate.
 * @throws {Error} With a descriptive message when the IP is rejected.
 */
export function validateWebhookIp(ip: string): void {
  const lower = ip.toLowerCase();

  // IPv6 unspecified and loopback
  if (lower === '::' || lower === '::1') {
    throw new Error(`Invalid webhook URL: IP address "${ip}" is loopback or unspecified`);
  }

  // IPv6 IPv4-mapped: ::ffff:a.b.c.d → unwrap and validate the v4 part.
  const mapped = /^::ffff:([0-9.]+)$/.exec(lower);
  if (mapped) {
    const mappedIpv4 = mapped[1];
    if (mappedIpv4) {
      validateWebhookIp(mappedIpv4);
    }
    return;
  }

  // IPv6 detection (contains ':' but no IPv4 mapped form)
  if (lower.includes(':')) {
    validateIPv6(lower);
    return;
  }

  // IPv4 dotted-quad
  const octets = lower.split('.');
  if (octets.length === 4 && octets.every(o => /^\d+$/.test(o))) {
    validateIPv4(lower, octets.map(Number) as [number, number, number, number]);
  }
  // Non-literal hostnames pass through; DNS rebinding is the caller's concern.
}

function validateIPv4(ip: string, [a, b]: [number, number, number, number]): void {
  // 0.0.0.0/8 — unspecified
  if (a === 0) {
    throw new Error(`Invalid webhook URL: IP address "${ip}" is not routable (0.0.0.0/8)`);
  }
  // 10.0.0.0/8 — private
  if (a === 10) {
    throw new Error(`Invalid webhook URL: IP address "${ip}" is in a private range (10.0.0.0/8)`);
  }
  // 127.0.0.0/8 — loopback
  if (a === 127) {
    throw new Error(
      `Invalid webhook URL: IP address "${ip}" is in the loopback range (127.0.0.0/8)`,
    );
  }
  // 169.254.0.0/16 — link-local (AWS/GCP/Azure metadata 169.254.169.254)
  if (a === 169 && b === 254) {
    throw new Error(
      `Invalid webhook URL: IP address "${ip}" is in the link-local range (169.254.0.0/16)`,
    );
  }
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) {
    throw new Error(
      `Invalid webhook URL: IP address "${ip}" is in a private range (172.16.0.0/12)`,
    );
  }
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) {
    throw new Error(
      `Invalid webhook URL: IP address "${ip}" is in a private range (192.168.0.0/16)`,
    );
  }
  // 100.64.0.0/10 — carrier-grade NAT (RFC 6598)
  if (a === 100 && b >= 64 && b <= 127) {
    throw new Error(
      `Invalid webhook URL: IP address "${ip}" is in the carrier-grade NAT range (100.64.0.0/10)`,
    );
  }
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) {
    throw new Error(`Invalid webhook URL: IP address "${ip}" is in the multicast range (224/4)`);
  }
  // 240.0.0.0/4 — reserved (includes 255.255.255.255 broadcast)
  if (a >= 240) {
    throw new Error(`Invalid webhook URL: IP address "${ip}" is reserved (240/4)`);
  }
}

function validateIPv6(ip: string): void {
  const stripped = ip.replace(/%.+$/, ''); // strip zone id, e.g. fe80::1%eth0
  // Expand to the first hextet for prefix checks. We do not do full canonical
  // expansion — prefix matches against compressed forms cover all the blocks
  // we care about because every block we reject starts at byte 0.
  const firstHextet = stripped.split(':')[0]?.toLowerCase() ?? '';

  // fe80::/10 — IPv6 link-local
  if (/^fe[89ab]/.test(firstHextet) && firstHextet.length === 4) {
    throw new Error(`Invalid webhook URL: IP address "${ip}" is in IPv6 link-local (fe80::/10)`);
  }
  if (firstHextet.length < 4 && /^fe[89ab]?$/.test(firstHextet)) {
    // Caught above when firstHextet length is 4; this branch is defensive
    // for shortened forms like "fe80:" being parsed unusually.
    throw new Error(`Invalid webhook URL: IP address "${ip}" is in IPv6 link-local (fe80::/10)`);
  }

  // fc00::/7 — IPv6 unique-local
  if (/^f[cd]/.test(firstHextet)) {
    throw new Error(`Invalid webhook URL: IP address "${ip}" is in IPv6 unique-local (fc00::/7)`);
  }

  // fec0::/10 — deprecated IPv6 site-local (RFC 3879) but still in some networks
  if (/^fe[cdef]/.test(firstHextet) && firstHextet.length === 4) {
    throw new Error(
      `Invalid webhook URL: IP address "${ip}" is in deprecated IPv6 site-local (fec0::/10)`,
    );
  }

  // ff00::/8 — IPv6 multicast
  if (firstHextet.startsWith('ff')) {
    throw new Error(`Invalid webhook URL: IP address "${ip}" is in IPv6 multicast (ff00::/8)`);
  }
}
