/**
 * Operation-level idempotency contract used by delivery and retry-aware packages
 * (mail, push, notifications, orchestration) to dedup retried operations.
 *
 * @remarks
 * This is distinct from the HTTP `IdempotencyAdapter` contract in
 * `../idempotencyAdapter.ts`, which is dedicated to the request-replay middleware
 * (caching the full HTTP response for a given `Idempotency-Key` header).
 *
 * The contract here is keyed on a structured `IdempotencyKey` and stores an
 * arbitrary payload (typed at the call site). Callers wrap their operation in
 * {@link withIdempotency} so that retries skip work and replay the prior result.
 */

/** Branded string used to keep idempotency keys distinct from arbitrary strings. */
export type IdempotencyKey = string & { readonly __brand: 'IdempotencyKey' };

/**
 * Build a deterministic idempotency key by joining the supplied parts with `:`.
 *
 * @param parts - Non-empty array of string or number parts.
 * @throws If `parts` is empty.
 */
export function makeIdempotencyKey(parts: ReadonlyArray<string | number>): IdempotencyKey {
  if (parts.length === 0) throw new Error('idempotency key parts cannot be empty');
  return parts.map(String).join(':') as IdempotencyKey;
}

/**
 * Storage contract for operation-level idempotency dedupe.
 *
 * @remarks
 * Note: the public re-export from `@lastshotlabs/slingshot-core` aliases this
 * interface to `OperationIdempotencyAdapter` to avoid clashing with the existing
 * HTTP `IdempotencyAdapter`. Within this module the canonical name is
 * `IdempotencyAdapter`.
 */
export interface IdempotencyAdapter {
  /** Returns the prior result if `key` was seen, otherwise `undefined`. */
  get(key: IdempotencyKey): Promise<{ recordedAt: number; payload?: unknown } | undefined>;
  /** Records the key with optional payload. Idempotent: a second call with the same key is a no-op. */
  set(key: IdempotencyKey, payload?: unknown, ttlMs?: number): Promise<void>;
}

/** Options controlling {@link withIdempotency} behaviour. */
export interface WithIdempotencyOptions {
  /** Time-to-live for the recorded entry, in milliseconds. */
  ttlMs?: number;
  /** If true (default), return the cached payload from a prior run; otherwise rerun fn. */
  reuseCachedPayload?: boolean;
}

/**
 * Wrap an async operation with idempotency-aware execution.
 *
 * On a cache hit (and when `reuseCachedPayload` is true, the default), this
 * returns the prior payload with `deduped: true` and does not invoke `fn`.
 * Otherwise it invokes `fn`, records the result under `key`, and returns it.
 */
export async function withIdempotency<T>(
  adapter: IdempotencyAdapter,
  key: IdempotencyKey,
  fn: () => Promise<T>,
  opts?: WithIdempotencyOptions,
): Promise<{ result: T; deduped: boolean }> {
  const reuse = opts?.reuseCachedPayload ?? true;
  const prior = await adapter.get(key);
  if (prior && reuse) {
    return { result: prior.payload as T, deduped: true };
  }
  const result = await fn();
  await adapter.set(key, result, opts?.ttlMs);
  return { result, deduped: false };
}

/**
 * In-memory adapter for tests and single-instance deployments.
 *
 * Uses simple FIFO eviction once `maxEntries` is reached.
 *
 * @remarks
 * This adapter stores idempotency state in process memory only. For
 * production multi-instance deployments, use a durable adapter backed by
 * a shared store (e.g. Redis, Postgres).
 */
export function createMemoryOperationIdempotencyAdapter(opts?: {
  defaultTtlMs?: number;
  maxEntries?: number;
}): IdempotencyAdapter {
  if (
    typeof process !== 'undefined' &&
    process.env?.NODE_ENV === 'production' &&
    typeof process.emitWarning === 'function'
  ) {
    process.emitWarning(
      'createMemoryOperationIdempotencyAdapter is in-memory only and will not ' +
        'deduplicate across instances. Use a shared-store adapter for production.',
      'ExperimentalWarning',
    );
  }
  const map = new Map<string, { recordedAt: number; payload?: unknown; expiresAt: number }>();
  const defaultTtl = opts?.defaultTtlMs ?? 24 * 60 * 60 * 1000;
  const maxEntries = opts?.maxEntries ?? 10_000;
  return {
    async get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt < Date.now()) {
        map.delete(key);
        return undefined;
      }
      return { recordedAt: entry.recordedAt, payload: entry.payload };
    },
    async set(key, payload, ttlMs) {
      const ttl = ttlMs ?? defaultTtl;
      if (map.size >= maxEntries && !map.has(key)) {
        const oldest = map.keys().next().value as string | undefined;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, { recordedAt: Date.now(), payload, expiresAt: Date.now() + ttl });
    },
  };
}
