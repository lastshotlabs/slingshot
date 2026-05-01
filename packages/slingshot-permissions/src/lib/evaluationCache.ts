/**
 * TTL-based evaluation cache for permission checks.
 *
 * Caches the boolean result of `evaluator.can()` calls keyed by
 * (subjectId + subjectType + action + tenantId + resourceType + resourceId).
 * On cache hit within the configured TTL the cached value is returned
 * without hitting the backing adapter.
 *
 * Use `invalidate()` after permission changes (grant create/revoke/delete)
 * to bust the entire cache, or `invalidateForActor(actorId)` to bust only
 * entries for a specific subject.
 */

// ── Public Types ──────────────────────────────────────────────────────────────

/**
 * A single entry in the evaluation cache.
 */
export interface EvaluationCacheEntry {
  /** The cached `can()` result. */
  readonly result: boolean;
  /** Wall-clock timestamp (ms) when the entry was cached. */
  readonly cachedAt: number;
}

/**
 * TTL-based evaluation cache.
 *
 * Thread-safe in the sense that JavaScript's event loop serialises Map access.
 * Not safe across multiple processes or host machines — each runtime instance
 * maintains its own in-memory cache.
 */
export interface EvaluationCache {
  /**
   * Return a cached entry, or `undefined` on miss (including expired entries).
   */
  get(
    subjectId: string,
    subjectType: string,
    action: string,
    scope?: {
      tenantId?: string | null;
      resourceType?: string | null;
      resourceId?: string | null;
    },
  ): EvaluationCacheEntry | undefined;

  /**
   * Store a result in the cache.
   */
  set(
    subjectId: string,
    subjectType: string,
    action: string,
    scope:
      | {
          tenantId?: string | null;
          resourceType?: string | null;
          resourceId?: string | null;
        }
      | undefined,
    result: boolean,
  ): void;

  /**
   * Bust every entry in the cache. Call this after any permission change
   * (grant created, revoked, deleted) to prevent stale allow/deny decisions.
   */
  invalidate(): void;

  /**
   * Bust only entries whose cache key begins with the given actor's identity.
   *
   * @param actorId - The subjectId whose cached entries should be removed.
   */
  invalidateForActor(actorId: string): void;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Options for {@link createEvaluationCache}.
 */
export interface EvaluationCacheOptions {
  /**
   * Time-to-live in milliseconds for each cached entry.
   *
   * Defaults to `5000` (5 seconds). Set to a value appropriate for your
   * permission-change frequency — a longer TTL improves throughput but
   * increases the window for stale results after grants change.
   */
  ttlMs?: number;

  /**
   * Maximum number of entries in the cache.
   *
   * When the cache exceeds this limit, the oldest entries (by insertion
   * order) are evicted on the next `set()`. Defaults to `10000`. Pass
   * `Infinity` to disable the cap.
   */
  maxEntries?: number;
}

/**
 * Create an in-memory evaluation cache with the given TTL.
 *
 * @example
 * ```ts
 * const cache = createEvaluationCache({ ttlMs: 10_000 }); // 10 second TTL
 * const evaluator = createPermissionEvaluator({ registry, adapter, cache });
 * ```
 */
export function createEvaluationCache(options?: EvaluationCacheOptions): EvaluationCache {
  const ttlMs = options?.ttlMs ?? 5000;
  const maxEntries = options?.maxEntries ?? 10_000;

  if (ttlMs <= 0) {
    throw new Error('[slingshot-permissions] evaluationCache ttlMs must be a positive number');
  }

  if (maxEntries <= 0) {
    throw new Error('[slingshot-permissions] evaluationCache maxEntries must be a positive number or Infinity');
  }

  const store = new Map<string, EvaluationCacheEntry>();

  function makeKey(
    subjectId: string,
    subjectType: string,
    action: string,
    scope?: {
      tenantId?: string | null;
      resourceType?: string | null;
      resourceId?: string | null;
    },
  ): string {
    return `${subjectId}::${subjectType}::${action}::${scope?.tenantId ?? ''}::${scope?.resourceType ?? ''}::${scope?.resourceId ?? ''}`;
  }

  return {
    get(subjectId, subjectType, action, scope) {
      const key = makeKey(subjectId, subjectType, action, scope);
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.cachedAt > ttlMs) {
        store.delete(key);
        return undefined;
      }
      return entry;
    },

    set(subjectId, subjectType, action, scope, result) {
      const key = makeKey(subjectId, subjectType, action, scope);

      // Enforce maxEntries cap — evict oldest entries (by insertion order)
      // when the cache has reached capacity and the key is not already present.
      if (store.size >= maxEntries && !store.has(key)) {
        const keysToEvict = store.size - maxEntries + 1;
        let evicted = 0;
        for (const existingKey of store.keys()) {
          if (evicted >= keysToEvict) break;
          store.delete(existingKey);
          evicted++;
        }
      }

      store.set(key, { result, cachedAt: Date.now() });
    },

    invalidate() {
      store.clear();
    },

    invalidateForActor(actorId: string) {
      const prefix = `${actorId}::`;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          store.delete(key);
        }
      }
    },
  };
}
