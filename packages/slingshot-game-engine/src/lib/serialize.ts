/**
 * Map/Set ↔ JSON serialization helpers.
 *
 * Entity `field.json()` fields store plain JSON. The game engine runtime
 * uses `Map` and `Set` in memory but serializes them before persisting.
 *
 * See spec §2.4.1 (Map/Set serialization rule).
 */

/**
 * Serialize a `Map` to a plain object for JSON storage.
 * Keys are coerced to strings via `String()`.
 */
export function serializeMap<K, V>(map: Map<K, V>): Record<string, V> {
  return Object.fromEntries(map) as Record<string, V>;
}

/**
 * Deserialize a plain object back to a `Map`.
 */
export function deserializeMap<V>(obj: Record<string, V>): Map<string, V> {
  return new Map(Object.entries(obj));
}

/**
 * Serialize a `Set` to an array for JSON storage.
 */
export function serializeSet<T>(set: Set<T>): T[] {
  return [...set];
}

/**
 * Deserialize an array back to a `Set`.
 */
export function deserializeSet<T>(arr: T[]): Set<T> {
  return new Set(arr);
}

/**
 * Deep-serialize a game state object, converting all `Map` and `Set`
 * instances to their JSON-compatible forms.
 *
 * Handles nested objects and arrays. Non-Map/Set values pass through.
 */
export function serializeGameState(state: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    result[key] = serializeValue(value);
  }
  return result;
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value) {
      obj[String(k)] = serializeValue(v);
    }
    return obj;
  }
  if (value instanceof Set) {
    return [...value].map(serializeValue);
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  if (value !== null && typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = serializeValue(v);
    }
    return obj;
  }
  return value;
}
