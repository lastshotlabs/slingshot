import { createHash } from 'node:crypto';

/**
 * Build a deterministic provider idempotency key for a given delivery attempt.
 *
 * The same `(deliveryId, attempt)` pair always produces the same string. Pass this
 * value to upstream provider APIs that accept an idempotency token so retries within
 * the same attempt do not produce duplicate sends.
 *
 * @param deliveryId - The Slingshot delivery record id.
 * @param attempt - The 1-based attempt number for this delivery.
 * @returns A stable key of the form `${deliveryId}:${attempt}`.
 */
export function buildProviderIdempotencyKey(deliveryId: string, attempt: number): string {
  return `${deliveryId}:${attempt}`;
}

/**
 * Derive a deterministic UUID v4-shaped string from an arbitrary key.
 *
 * Hashes the input with SHA-256, then reformats the first 16 bytes into the
 * canonical 8-4-4-4-12 hex layout, setting the version (4) and variant (RFC 4122)
 * bits. The output is byte-stable for a given input — useful for headers like
 * APNs `apns-id` that require a UUID but where idempotency derives from a
 * caller-controlled token.
 *
 * @param key - Any input string (typically the provider idempotency key).
 * @returns A lowercase UUID v4 string.
 */
export function deriveUuidV4FromKey(key: string): string {
  const hash = createHash('sha256').update(key).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error('unable to derive UUID from idempotency key');
  }
  // Set version (4) in byte 6 and variant (10xx) in byte 8 per RFC 4122.
  bytes[6] = (versionByte & 0x0f) | 0x40;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
