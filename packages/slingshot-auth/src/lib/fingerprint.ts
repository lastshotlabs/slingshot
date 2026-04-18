const BROWSER_HEADERS = [
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'origin',
  'referer',
  'x-requested-with',
] as const;

const encoder = new TextEncoder();

/**
 * Derives a 12-character hex fingerprint from stable, IP-independent HTTP headers.
 *
 * The fingerprint is computed as the first 6 bytes (12 hex chars) of a SHA-256
 * digest over a pipe-delimited string of:
 * - `User-Agent`
 * - `Accept`
 * - `Accept-Language`
 * - `Accept-Encoding`
 * - `Connection`
 * - A 9-bit presence bitmask of browser-only Sec- / Origin / Referer headers
 *   (each `1` when the header is present, `0` when absent).
 *
 * Because IP is excluded, clients that rotate IP addresses but share the same
 * HTTP stack (e.g. cloud scrapers, malicious bots) will produce the same
 * fingerprint and fall into the same rate-limit bucket.
 *
 * @param req - The incoming `Request` object.
 * @returns A 12-character lowercase hex string (48-bit fingerprint).
 *
 * @remarks
 * The fingerprint is a probabilistic identifier — collisions are possible but
 * unlikely in practice.  It is not a security primitive for authentication;
 * it is a rate-limiting and session-binding heuristic only.
 *
 * The bitmask encodes the following headers in order:
 * `sec-fetch-site`, `sec-fetch-mode`, `sec-fetch-dest`, `sec-ch-ua`,
 * `sec-ch-ua-mobile`, `sec-ch-ua-platform`, `origin`, `referer`,
 * `x-requested-with`.  Real browsers send most of these; raw HTTP clients
 * typically send none, yielding a `"000000000"` bitmap.
 *
 * @example
 * const fp = await buildFingerprint(request);
 * // fp: 'a3f7e21b0c4d'
 *
 * // In a rate-limit middleware:
 * const bucket = `rate:${fp}`;
 * const count = Number(await cache.get(bucket) ?? 0);
 * if (count >= 100) return c.json({ error: 'Too many requests' }, 429);
 * await cache.set(bucket, String(count + 1), 60);
 */
export async function buildFingerprint(req: Request): Promise<string> {
  const h = (name: string) => req.headers.get(name) ?? '';

  // Encode which browser-only headers are present as a bitmask string.
  // Real browsers send most of these; raw HTTP clients send none.
  const bitmap = BROWSER_HEADERS.map(name => (req.headers.has(name) ? '1' : '0')).join('');

  const raw = [
    h('user-agent'),
    h('accept'),
    h('accept-language'),
    h('accept-encoding'),
    h('connection'),
    bitmap,
  ].join('|');

  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(raw));
  const bytes = new Uint8Array(buf).slice(0, 6);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
