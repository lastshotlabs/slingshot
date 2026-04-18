/**
 * Produces a collision-safe composite key for scoping rooms to an endpoint.
 *
 * Both endpoint and room are percent-encoded before joining with `:`.
 * Since encodeURIComponent encodes `:` → `%3A`, the literal `:` separator
 * can only come from this function — not from endpoint or room values.
 *
 * Examples:
 *   wsEndpointKey("/chat", "general")     → "%2Fchat:general"
 *   wsEndpointKey("/chat", "room:1")      → "%2Fchat:room%3A1"
 *   wsEndpointKey("/a:b", "c")            → "%2Fa%3Ab:c"
 *   wsEndpointKey("/notifications", "x")  → "%2Fnotifications:x"
 *
 * Used for: in-memory room maps, Redis channel names, Redis message keys.
 * NOT used for: SQLite or MongoDB schemas (those store endpoint + room separately).
 */
export function wsEndpointKey(endpoint: string, room: string): string {
  return `${encodeURIComponent(endpoint)}:${encodeURIComponent(room)}`;
}
