/**
 * Shared cursor encoding/decoding for adapter pagination.
 *
 * All adapters encode cursors as base64-encoded JSON. The payload shape varies
 * by domain (timestamps vs sequence numbers, id vs _id), so the encode/decode
 * functions are generic over the payload type.
 */

/**
 * Encode a cursor payload as a URL-safe base64 string.
 *
 * Serialises `payload` as JSON then base64-encodes it using `btoa`. The result
 * is an opaque string safe to include in query parameters without URL encoding.
 * Reverse with `decodeCursor`.
 *
 * @param payload - The cursor state to encode (must be JSON-serialisable).
 * @returns An opaque base64 string representing the cursor.
 *
 * @example
 * ```ts
 * import { encodeCursor } from '@lastshotlabs/slingshot-core';
 *
 * const cursor = encodeCursor({ createdAt: '2024-01-01T00:00:00Z', id: 'msg_123' });
 * // → 'eyJjcmVhdGVkQXQiOiIyMDI0LTAxLTAxVDAwOjAwOjAwWiIsImlkIjoibXNnXzEyMyJ9'
 * ```
 */
export function encodeCursor(payload: object): string {
  return btoa(JSON.stringify(payload));
}

/**
 * Decode a base64 cursor string back to its typed payload.
 *
 * Returns `null` if the cursor is malformed (invalid base64 or non-JSON).
 * When a `validate` type guard is provided, the decoded value is checked at
 * runtime and `null` is returned if it fails the guard.
 *
 * @param cursor - The opaque base64 cursor string (from a previous `encodeCursor` call).
 * @param validate - Optional type guard to validate the decoded payload shape.
 * @returns The decoded payload, or `null` if the cursor is invalid or fails the guard.
 *
 * @example
 * ```ts
 * import { decodeCursor } from '@lastshotlabs/slingshot-core';
 *
 * const payload = decodeCursor<{ createdAt: string; id: string }>(cursor, (v): v is ... => {
 *   return typeof (v as any)?.id === 'string';
 * });
 * if (!payload) return c.json({ error: 'Invalid cursor' }, 400);
 * ```
 */
export function decodeCursor<T extends object>(
  cursor: string,
  validate?: (parsed: unknown) => parsed is T,
): T | null {
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    if (validate && !validate(parsed)) return null;
    return parsed as T;
  } catch {
    // Malformed cursor — return null per contract (callers treat null as "start from beginning")
    return null;
  }
}
