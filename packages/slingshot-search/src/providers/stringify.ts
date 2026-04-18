/**
 * Shared stringification helpers for provider-facing values.
 *
 * Search data is often `unknown` at the boundaries. These helpers keep
 * string coercion explicit so we don't accidentally fall back to
 * `"[object Object]"` for complex values.
 */

export function stringifySearchValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'symbol' || typeof value === 'function') {
    return fallback;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

export function stringifyDocumentId(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return fallback;
}
