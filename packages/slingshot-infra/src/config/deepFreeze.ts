/**
 * Deep-freeze an object and all nested objects/arrays.
 *
 * Satisfies engineering rule 10: config objects must be deeply frozen at the
 * boundary, not just shallow-frozen. Used by `definePlatform()`, `defineInfra()`,
 * and `auditWebsocketScaling()`.
 *
 * @param value - The value to deep-freeze. Primitives and already-frozen objects
 *   are returned as-is.
 * @returns The same reference, now deeply frozen.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
