/**
 * Helpers for implementing `InboundProvider.verify()` safely.
 *
 * Inbound webhook bodies arrive as raw strings supplied by an external sender. A naive
 * `JSON.parse(rawBody)` will throw a `SyntaxError` when the sender (whether buggy or
 * malicious) posts a malformed payload, which would otherwise propagate up into the
 * route handler and surface as a generic 500. `safeParseInboundBody` keeps that failure
 * mode local to the provider so it can return `{ verified: false, reason }` cleanly.
 */

/**
 * Result of {@link safeParseInboundBody}.
 */
export type SafeParseInboundBodyResult =
  | { ok: true; payload: unknown }
  | { ok: false; reason: string };

/**
 * Safely parse a raw inbound webhook body string as JSON.
 *
 * Returns `{ ok: true, payload }` on success, or `{ ok: false, reason }` for any
 * non-string input, empty body, or `JSON.parse` failure. Implementers should map a
 * failed result to `{ verified: false, reason }` in their `InboundProvider.verify()`
 * return value so the route can respond with HTTP 400.
 *
 * @param rawBody - The raw request body string supplied by the inbound route.
 * @returns A discriminated-union result describing parse success or failure.
 *
 * @example
 * ```ts
 * const parsed = safeParseInboundBody(rawBody);
 * if (!parsed.ok) {
 *   return { verified: false, reason: parsed.reason };
 * }
 * return { verified: true, payload: parsed.payload };
 * ```
 */
export function safeParseInboundBody(rawBody: string): SafeParseInboundBodyResult {
  if (typeof rawBody !== 'string') {
    return { ok: false, reason: 'inbound body must be a string' };
  }
  if (rawBody.length === 0) {
    return { ok: false, reason: 'inbound body is empty' };
  }
  try {
    const payload = JSON.parse(rawBody) as unknown;
    return { ok: true, payload };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `invalid JSON: ${detail}` };
  }
}
