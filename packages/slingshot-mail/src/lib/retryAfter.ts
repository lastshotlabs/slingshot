/**
 * Parses an HTTP `Retry-After` header value into milliseconds.
 *
 * Accepts the two formats defined by RFC 7231 §7.1.3:
 *   1. A non-negative integer number of seconds (e.g. `"120"`).
 *   2. An HTTP-date (e.g. `"Wed, 21 Oct 2026 07:28:00 GMT"`).
 *
 * Returns `undefined` when the value is missing or cannot be parsed. Pattern
 * mirrors `slingshot-push`'s web push provider so retry semantics are uniform
 * across delivery surfaces.
 *
 * @param value - Raw header value as returned by the provider.
 * @returns Delay in milliseconds, or `undefined` if unparsable.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  // RFC 7231 §7.1.3 allows the field to be a non-negative integer (seconds)
  // or an HTTP-date. Detect numeric strings up front so a negative or
  // garbage numeric value isn't silently coerced to a date by `Date.parse`.
  const numericMatch = /^\s*-?\d+(?:\.\d+)?\s*$/.test(value);
  if (numericMatch) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.trunc(seconds * 1000);
    return undefined;
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

/**
 * Extracts a `Retry-After` header from any of the shapes providers expose:
 *   - A standard `Headers` instance (fetch responses).
 *   - A plain object (some SDKs surface response headers as a map).
 *
 * Header names are case-insensitive: `Retry-After` and `retry-after` both work.
 *
 * @param headers - Header bag in either shape, or any other value.
 * @returns The first matching header value, or `undefined`.
 */
export function extractRetryAfterHeader(headers: unknown): string | null | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const h = headers as { get?: (k: string) => string | null } & Record<string, unknown>;
  if (typeof h.get === 'function') {
    return h.get('retry-after');
  }
  const direct = h['retry-after'] ?? h['Retry-After'];
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0];
  return undefined;
}
