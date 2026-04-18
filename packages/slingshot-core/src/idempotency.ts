/**
 * Storage contract for idempotency key deduplication.
 *
 * When a client retries a mutating request with the same `Idempotency-Key` header,
 * the idempotency middleware looks up the cached response via this adapter and returns
 * it instead of executing the handler again.
 *
 * @remarks
 * Implementations must respect the `ttlSeconds` argument in `set()` — records should
 * expire automatically after the configured TTL. The framework sets a default TTL of
 * 24 hours for idempotency records.
 *
 * @example
 * ```ts
 * import type { IdempotencyAdapter } from '@lastshotlabs/slingshot-core';
 *
 * export function createRedisIdempotencyAdapter(redis: RedisLike): IdempotencyAdapter {
 *   return {
 *     async get(key) {
 *       const raw = await redis.get(`idmp:${key}`);
 *       return raw ? JSON.parse(raw) : null;
 *     },
 *     async set(key, response, status, ttlSeconds, meta) {
 *       await redis.setex(
 *         `idmp:${key}`,
 *         ttlSeconds,
 *         JSON.stringify({
 *           response,
 *           status,
 *           createdAt: Date.now(),
 *           requestFingerprint: meta?.requestFingerprint ?? null,
 *         }),
 *       );
 *     },
 *   };
 * }
 * ```
 */
export interface IdempotencyAdapter {
  /**
   * Look up a cached idempotency record.
   * @param key - The idempotency key from the request header.
   * @returns The stored record, or `null` on a cache miss (key not found or TTL expired).
   *
   * @remarks
   * The returned `response` field is a raw JSON string — callers are responsible for
   * deserialising it (e.g. `JSON.parse(record.response)`). On a cache hit, the middleware
   * short-circuits the handler and replays the stored `response` and `status` directly to
   * the client without executing the route handler again.
   */
  get(key: string): Promise<{
    response: string;
    status: number;
    createdAt: number;
    requestFingerprint?: string | null;
  } | null>;

  /**
   * Cache a response for an idempotency key.
   * @param key - The idempotency key.
   * @param response - The serialised response body (JSON string).
   * @param status - The HTTP status code of the response.
   * @param ttlSeconds - How long to retain this record (seconds).
   * @param meta - Optional metadata associated with the original request.
   *
   * @remarks
   * Implementations MUST honour `ttlSeconds` — records that outlive their TTL will cause
   * stale responses to be replayed to clients. For Redis-backed adapters, use `SETEX` (or
   * equivalent `SET ... EX`) to delegate TTL enforcement to Redis. The framework passes
   * 86400 (24 hours) as the default TTL; app configs may override this.
   */
  set(
    key: string,
    response: string,
    status: number,
    ttlSeconds: number,
    meta?: { requestFingerprint?: string | null },
  ): Promise<void>;

  /**
   * Remove all stored idempotency records.
   *
   * @remarks
   * Called by `ctx.clear()` between test cases to prevent a cached response from one test
   * from being replayed in the next. This is a test-isolation utility — do not call it in
   * production. Implementations that back the idempotency store with a shared Redis
   * instance should scope the clear to a test-specific key namespace to avoid affecting
   * other concurrent test workers.
   */
  clear?(): Promise<void>;
}
