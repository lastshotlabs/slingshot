/**
 * Return the first non-empty string from a list of values.
 * Used to extract correlation IDs from trigger-specific fields.
 *
 * @param values - Values to search, in priority order.
 * @returns The first non-empty string, or `null` if none found.
 */
export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Case-insensitive header lookup from a plain-object header map.
 *
 * @param headers - Header record (keys are header names).
 * @param key - Header name to find (case-insensitive).
 * @returns The header value, or `null` if absent or empty.
 */
export function readHeader(
  headers: Record<string, string | undefined> | undefined,
  key: string,
): string | null {
  if (!headers) return null;
  const match = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase());
  return match && typeof match[1] === 'string' && match[1].length > 0 ? match[1] : null;
}

/**
 * Attempt to parse a value as JSON. Returns the original value on failure.
 *
 * @param value - Value that may be a JSON string.
 * @returns The parsed object/array, or the original value if parsing fails.
 */
export function decodeMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * Base64-decode a string, then attempt JSON parse. Returns the original value on failure.
 *
 * @param value - Base64-encoded string.
 * @returns The decoded and parsed value, or the original string.
 */
export function decodeBase64JsonOrText(value: string): unknown {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    return decodeMaybeJson(text);
  } catch {
    return value;
  }
}

/**
 * Decode an HTTP request body, handling base64-encoded payloads.
 *
 * @param body - Raw body string (or null/undefined).
 * @param isBase64Encoded - Whether the body is base64-encoded (e.g. API Gateway).
 * @returns The decoded body as a parsed object, or `{}` if the body is empty.
 */
export function decodeHttpBody(
  body: string | null | undefined,
  isBase64Encoded?: boolean,
): unknown {
  if (!body) return {};
  return isBase64Encoded ? decodeBase64JsonOrText(body) : decodeMaybeJson(body);
}
