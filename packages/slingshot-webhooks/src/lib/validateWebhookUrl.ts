/**
 * SSRF protection for webhook target URLs.
 *
 * Rejects URLs that target private infrastructure:
 * - Non-HTTP/HTTPS schemes
 * - Loopback hostnames (`localhost`, `127.x.x.x`, `::1`)
 * - Link-local addresses (`169.254.x.x`)
 * - Private IPv4 ranges (`10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`)
 * - The unspecified address (`0.0.0.0`)
 *
 * DNS resolution is intentionally not performed here. Hostname-based checks
 * catch the most common attack vectors without the latency and DNS-rebinding
 * bypass risk of live resolution.
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

  if (host === 'localhost') {
    throw new Error('Invalid webhook URL: "localhost" is not allowed (loopback address)');
  }

  // IPv6 loopback: [::1]
  if (host === '::1' || host === '[::1]') {
    throw new Error('Invalid webhook URL: "::1" is not allowed (IPv6 loopback address)');
  }

  // Strip IPv6 brackets for range checks
  const ip = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  const octets = ip.split('.');
  if (octets.length === 4) {
    const [a, b] = octets.map(Number);

    // 0.0.0.0 — unspecified
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

    // 169.254.0.0/16 — link-local (includes AWS metadata 169.254.169.254)
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
  }
}
