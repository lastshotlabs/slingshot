// packages/slingshot-chat/src/lib/utils.ts

/**
 * Generate an ISO-8601 timestamp for the current moment.
 * @internal
 */
export function now(): string {
  return new Date().toISOString();
}

/**
 * Generate a UUID v4.
 * Uses `crypto.randomUUID()` — available in Bun and modern Node.
 * @internal
 */
export function uuid(): string {
  return crypto.randomUUID();
}
