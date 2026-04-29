// packages/runtime-edge/src/kv-isr.ts
import type { IsrCacheAdapter, IsrCacheEntry } from '@lastshotlabs/slingshot-ssr';

// ---------------------------------------------------------------------------
// Cloudflare Workers platform constants
// ---------------------------------------------------------------------------

/**
 * Cloudflare Workers cap each request at 50 subrequests on the free plan and
 * 1000 on paid. The conservative default keeps writes safe on either tier.
 * A KV `put`/`delete` counts as one subrequest, so a single `set()` or
 * `invalidateTag()` that fans out to N tag-index writes burns N subrequests.
 */
const DEFAULT_MAX_KV_CONCURRENCY = 25;

/**
 * Default per-operation timeout for KV reads/writes. Cloudflare Workers enforce
 * a 30s wall-clock per request; KV calls have no client-side timeout, so a
 * hung KV operation can consume the entire request budget.
 */
const DEFAULT_KV_OP_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// AbortController-backed timeout for KV operations
// ---------------------------------------------------------------------------

/**
 * Custom error thrown when a KV operation exceeds its deadline.
 */
class KvOperationTimeoutError extends Error {
  constructor(opName: string, timeoutMs: number) {
    super(`[runtime-edge] KV ${opName} timed out after ${timeoutMs}ms`);
    this.name = 'KvOperationTimeoutError';
  }
}

/**
 * Race an operation against an AbortController-backed timeout.
 *
 * Unlike the earlier implementation which only raced a timer and left the
 * underlying promise dangling, this version creates an `AbortController`,
 * passes its signal to the operation callback, and aborts the controller
 * when the deadline fires. Operations that accept the signal (e.g., via a
 * future `KvNamespace` that honours `AbortSignal`) can cancel their work.
 *
 * When `heartbeatTimeoutMs` is set and greater than `timeoutMs`, the shorter
 * of the two is used (the heartbeat acts as a global cap).
 *
 * @param opName - Human-readable name for the operation (e.g. `'get'`).
 * @param op - Factory that receives an `AbortSignal` and returns the op promise.
 * @param timeoutMs - Per-operation timeout in ms. 0 disables.
 * @param heartbeatMs - Optional global heartbeat cap. The effective timeout
 *   is `Math.min(timeoutMs, heartbeatMs)` when both are positive.
 * @returns The operation's result, or rejects with `KvOperationTimeoutError`.
 */
function withAbortTimeout<T>(
  opName: string,
  op: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  heartbeatMs: number = 0,
): Promise<T> {
  const effectiveMs =
    timeoutMs > 0 && heartbeatMs > 0
      ? Math.min(timeoutMs, heartbeatMs)
      : timeoutMs > 0
        ? timeoutMs
        : heartbeatMs;

  if (effectiveMs <= 0) {
    return op(new AbortController().signal);
  }

  const controller = new AbortController();
  const signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), effectiveMs);

  const cleanup = (): void => {
    clearTimeout(timer);
  };

  const opPromise = op(signal).then(
    v => {
      cleanup();
      return v;
    },
    err => {
      cleanup();
      throw err;
    },
  );

  // Race the operation against the abort signal so we reject as soon as
  // the timeout fires, even if the op doesn't check the signal.
  return Promise.race([
    opPromise,
    new Promise<T>((_, reject) => {
      if (signal.aborted) {
        reject(new KvOperationTimeoutError(opName, effectiveMs));
        return;
      }
      const onAbort = (): void => {
        reject(new KvOperationTimeoutError(opName, effectiveMs));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Concurrency-limited fan-out
// ---------------------------------------------------------------------------

/**
 * Run async tasks with a maximum concurrency, returning when all settle.
 * Throws if any task rejects (matches Promise.all semantics).
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const limit = Math.max(1, Math.min(concurrency, tasks.length));
  for (let i = 0; i < limit; i++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = next++;
          if (idx >= tasks.length) return;
          results[idx] = await tasks[idx]();
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// KV namespace structural interface
// ---------------------------------------------------------------------------

/**
 * Minimal structural interface for a Cloudflare KV Namespace.
 *
 * Defined structurally so `runtime-edge` does not require `@cloudflare/workers-types`
 * as a dependency. Any KV binding that satisfies these method signatures is compatible
 * — Cloudflare KV, Upstash KV (with adapter), Vercel KV, Deno KV (wrapped), or an
 * in-memory mock.
 *
 * @example
 * ```ts
 * // In your worker, the KV binding satisfies this interface automatically:
 * const cache = createKvIsrCache(env.ISR_CACHE);
 * ```
 */
export interface KvNamespace {
  /**
   * Get the string value of a KV key.
   * Returns `null` if the key does not exist.
   *
   * The `options` argument matches the Cloudflare KV signature; mocks should
   * accept it (and may ignore it) so test stubs satisfy the interface in
   * strict-mode TypeScript.
   */
  get(key: string, options?: { type: 'text' }): Promise<string | null>;
  /**
   * Put a value into KV with an optional TTL.
   * @param key - The key to write.
   * @param value - The string value to store.
   * @param options - Optional configuration.
   * @param options.expirationTtl - Seconds until the key expires.
   */
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  /**
   * Delete a KV key.
   */
  delete(key: string): Promise<void>;
  /**
   * List KV keys, optionally filtered by prefix.
   * Returns up to 1000 keys per call (Cloudflare KV limitation).
   */
  list(options?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }>;
}

// ---------------------------------------------------------------------------
// Logger hook
// ---------------------------------------------------------------------------

/**
 * Structured logger surface for the edge runtime. Defaults to `console.error`.
 * Production deployments should swap in a logger that forwards to their
 * observability backend (Logtail, Datadog, Workers Analytics Engine, etc.).
 */
export interface RuntimeEdgeLogger {
  error(event: string, fields?: Record<string, unknown>): void;
}

let activeLogger: RuntimeEdgeLogger = {
  error(event, fields) {
    if (fields && Object.keys(fields).length > 0) {
      console.error(`[runtime-edge] ${event}`, fields);
    } else {
      console.error(`[runtime-edge] ${event}`);
    }
  },
};

/**
 * Replace the runtime-edge structured logger. Pass `null` to reset to the
 * default `console.error`-backed logger. Returns the previous logger.
 */
export function configureRuntimeEdgeLogger(logger: RuntimeEdgeLogger | null): RuntimeEdgeLogger {
  const previous = activeLogger;
  activeLogger = logger ?? {
    error(event, fields) {
      if (fields && Object.keys(fields).length > 0) {
        console.error(`[runtime-edge] ${event}`, fields);
      } else {
        console.error(`[runtime-edge] ${event}`);
      }
    },
  };
  return previous;
}

// ---------------------------------------------------------------------------
// Key scheme constants
// ---------------------------------------------------------------------------

/** KV key prefix for cached ISR page entries (stored as JSON IsrCacheEntry). */
const PAGE_PREFIX = 'isr:page:';
/** KV key prefix for tag-to-paths index entries (stored as JSON string[]). */
const TAG_PREFIX = 'isr:tag:';

function pageKey(path: string): string {
  return `${PAGE_PREFIX}${path}`;
}

function tagKey(tag: string): string {
  return `${TAG_PREFIX}${tag}`;
}

// ---------------------------------------------------------------------------
// Per-tag serialization lock with bounded growth
// ---------------------------------------------------------------------------

/**
 * Per-tag promise chain used to serialize tag index read-modify-write operations.
 *
 * Cloudflare KV has no CAS primitive, so concurrent `set()` calls for pages
 * sharing a tag would race on the JSON array stored at `isr:tag:{tag}`. Chaining
 * updates through a per-tag promise ensures they execute one at a time within a
 * single Worker isolate, eliminating the in-process race.
 *
 * **Memory safety:** earlier versions of this map grew unbounded — every unique
 * tag added an entry that was never deleted, leaking ~1 KB of promise chain
 * state per tag in long-running Workers. We now evict the entry once the
 * promise settles, provided no later caller has chained onto it. With
 * `set(tag, current)` we use a sentinel comparison to detect that nobody else
 * extended the chain before deleting it.
 *
 * Cross-instance races are still unprotected — Cloudflare KV is eventually
 * consistent. For strict cross-instance consistency, use Durable Objects.
 *
 * @internal
 */
const tagLocks = new Map<string, Promise<void>>();

/**
 * Test-only accessor for the tag-lock map size. Used to assert that the map
 * does not grow unbounded after operations complete.
 *
 * @internal
 */
export function tagLocksSize(): number {
  return tagLocks.size;
}

/**
 * Wait for all pending tag-lock chains to settle. Test helper; not part of
 * the public adapter contract.
 *
 * @internal
 */
export async function flushTagLocks(): Promise<void> {
  const pending = Array.from(tagLocks.values());
  await Promise.allSettled(pending);
  // Allow the .finally() handlers (which delete entries) to run.
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Run `op` under the per-tag serialization lock and return both the
 * caller-visible promise (which surfaces errors) and a fire-and-forget
 * promise stored in `tagLocks` (which absorbs errors so the chain doesn't
 * poison subsequent callers). Once the chain settles, the entry is deleted
 * iff no later caller has overwritten it.
 */
function runUnderTagLock(tag: string, op: () => Promise<void>): Promise<void> {
  const prev = tagLocks.get(tag) ?? Promise.resolve();
  const visible = prev.then(op);
  // Build the chain entry: a promise that swallows errors (so future callers
  // don't inherit a rejection) and self-evicts when no one else has appended.
  const chained: Promise<void> = visible.catch(err => {
    activeLogger.error('tag-index-update-failed', {
      tag,
      message: err instanceof Error ? err.message : String(err),
    });
  });
  const evicting: Promise<void> = chained.finally(() => {
    if (tagLocks.get(tag) === evicting) {
      tagLocks.delete(tag);
    }
  });
  tagLocks.set(tag, evicting);
  return visible;
}

/**
 * Append `path` to the tag index for `tag` in a serialized, race-safe manner.
 *
 * @param kv - The KV namespace to read/write.
 * @param tag - The tag whose index should be updated.
 * @param path - The URL path to append to the tag index.
 * @param timeoutMs - Per-operation timeout in ms (passed to the KV calls).
 * @param heartbeatMs - Optional global heartbeat cap for KV operations.
 * @internal
 */
function updateTagIndex(
  kv: KvNamespace,
  tag: string,
  path: string,
  timeoutMs: number,
  heartbeatMs: number,
): Promise<void> {
  return runUnderTagLock(tag, async () => {
    const raw = await withAbortTimeout(
      'get',
      signal => kv.get(tagKey(tag), { type: 'text' }),
      timeoutMs,
      heartbeatMs,
    );
    let paths: string[];
    if (raw !== null) {
      try {
        paths = JSON.parse(raw) as string[];
      } catch {
        // Index corrupt — log and rebuild with this path. Logging preserves
        // observability for tag-index divergence (was silently swallowed
        // pre-hardening).
        activeLogger.error('tag-index-parse-failed', { tag, op: 'update' });
        paths = [];
      }
    } else {
      paths = [];
    }
    if (!paths.includes(path)) {
      paths.push(path);
      await withAbortTimeout(
        'put',
        signal => kv.put(tagKey(tag), JSON.stringify(paths)),
        timeoutMs,
        heartbeatMs,
      );
    }
  });
}

/**
 * Remove `path` from the tag index for `tag` in a serialized, race-safe manner.
 *
 * @param kv - The KV namespace to read/write.
 * @param tag - The tag whose index should be updated.
 * @param path - The URL path to remove from the tag index.
 * @param timeoutMs - Per-operation timeout in ms (passed to the KV calls).
 * @param heartbeatMs - Optional global heartbeat cap for KV operations.
 * @internal
 */
function removeFromTagIndex(
  kv: KvNamespace,
  tag: string,
  path: string,
  timeoutMs: number,
  heartbeatMs: number,
): Promise<void> {
  return runUnderTagLock(tag, async () => {
    const raw = await withAbortTimeout(
      'get',
      signal => kv.get(tagKey(tag), { type: 'text' }),
      timeoutMs,
      heartbeatMs,
    );
    if (raw === null) return;
    let paths: string[];
    try {
      paths = JSON.parse(raw) as string[];
    } catch {
      activeLogger.error('tag-index-parse-failed', { tag, op: 'remove' });
      return;
    }
    const filtered = paths.filter(p => p !== path);
    if (filtered.length === paths.length) return; // path wasn't present
    if (filtered.length === 0) {
      await withAbortTimeout(
        'delete',
        signal => kv.delete(tagKey(tag)),
        timeoutMs,
        heartbeatMs,
      );
    } else {
      await withAbortTimeout(
        'put',
        signal => kv.put(tagKey(tag), JSON.stringify(filtered)),
        timeoutMs,
        heartbeatMs,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Tunable knobs for {@link createKvIsrCache}.
 */
export interface KvIsrCacheOptions {
  /**
   * Maximum concurrent KV subrequests during fan-out (set/invalidateTag).
   *
   * Cloudflare Workers cap subrequests at 50 (free) / 1000 (paid) per request.
   * The default of 25 stays well under both ceilings; increase only if you've
   * confirmed your plan tier and request budget allow it.
   */
  maxConcurrency?: number;
  /**
   * Per-KV-operation timeout in milliseconds. Cloudflare KV has no client-side
   * timeout; without one a hung KV call can consume the full 30 s request
   * budget. Defaults to 5 000 ms. Set to 0 to disable.
   *
   * When both `operationTimeoutMs` and `heartbeatTimeoutMs` are set, the
   * effective timeout is the shorter of the two (the heartbeat acts as a
   * global cap on all operations within a single request).
   */
  operationTimeoutMs?: number;
  /**
   * Global heartbeat timeout in milliseconds for all KV operations within
   * a single ISR cache call.
   *
   * This acts as an upper bound on every individual KV `get`, `put`, and
   * `delete` operation. When set, it is combined with `operationTimeoutMs`
   * via `Math.min` to produce the effective per-operation deadline.
   *
   * Use this when you want a single consistent timeout policy across all
   * sub-operations without tuning each one individually.
   *
   * Defaults to 0 (disabled).
   */
  heartbeatTimeoutMs?: number;
}

/**
 * Create an ISR cache adapter backed by Cloudflare KV.
 *
 * Suitable for multi-instance Cloudflare Workers deployments. Each Worker
 * instance reads and writes through the shared KV namespace, ensuring that
 * ISR cache invalidations propagate globally.
 *
 * **Key scheme:**
 * - `isr:page:{path}` — JSON-serialized `IsrCacheEntry` for the given URL path.
 * - `isr:tag:{tag}` — JSON-serialized `string[]` of paths tagged with the given tag.
 *
 * **TTL behaviour:**
 * KV entries for page caches are written without a TTL — the ISR middleware's
 * stale-while-revalidate logic controls staleness via `IsrCacheEntry.revalidateAfter`.
 * Tag index entries are also written without a TTL. Invalidation removes keys
 * explicitly via `kv.delete()`.
 *
 * **Eventual consistency:**
 * Cloudflare KV has eventual consistency guarantees. Invalidation may take up to
 * 60 seconds to propagate globally. For strict consistency requirements, use
 * Cloudflare Durable Objects instead.
 *
 * **Cross-Worker race window:**
 * Two Worker instances calling `set()` simultaneously for pages that share a tag
 * may overwrite each other's tag index updates — KV has no compare-and-swap
 * primitive. Within a single Worker isolate, updates are serialized via an
 * in-process promise chain. The promise chain is bounded — entries are evicted
 * once they settle, preventing unbounded memory growth.
 *
 * **Timeout behaviour:**
 * Every KV operation is wrapped with an `AbortController`-backed timeout via
 * `withAbortTimeout`. When the timeout fires, the controller is aborted and
 * any `AbortSignal`-aware KV binding can cancel its work. Unlike the earlier
 * `setTimeout`-only approach, the abort signal provides a standard cancellation
 * mechanism for operations that support it.
 *
 * @param kv - A Cloudflare KV namespace binding. Satisfies `KvNamespace` structurally.
 * @param options - Optional tuning for concurrency and operation timeouts.
 * @returns An `IsrCacheAdapter` backed by the given KV namespace.
 *
 * @example
 * ```ts
 * import { createKvIsrCache } from '@lastshotlabs/slingshot-runtime-edge/kv';
 *
 * interface Env {
 *   ISR_CACHE: KVNamespace;
 * }
 *
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> {
 *     const app = await createApp({
 *       plugins: [
 *         createSsrPlugin({
 *           isr: { adapter: createKvIsrCache(env.ISR_CACHE) },
 *           // ...
 *         }),
 *       ],
 *     });
 *     return app.fetch(request);
 *   },
 * };
 * ```
 */
export function createKvIsrCache(
  kv: KvNamespace,
  options: KvIsrCacheOptions = {},
): IsrCacheAdapter {
  const concurrency = options.maxConcurrency ?? DEFAULT_MAX_KV_CONCURRENCY;
  const timeoutMs = options.operationTimeoutMs ?? DEFAULT_KV_OP_TIMEOUT_MS;
  const heartbeatMs = options.heartbeatTimeoutMs ?? 0;
  return {
    /**
     * Retrieve the cached entry for a URL path.
     *
     * @param path - The URL pathname to look up (e.g. `'/posts/nba-finals'`).
     * @returns The cached entry, or `null` on a miss or parse failure.
     */
    async get(path: string): Promise<IsrCacheEntry | null> {
      const raw = await withAbortTimeout(
        'get',
        signal => kv.get(pageKey(path), { type: 'text' }),
        timeoutMs,
        heartbeatMs,
      );
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as IsrCacheEntry;
      } catch {
        // Corrupt KV entry — treat as a cache miss.
        return null;
      }
    },

    /**
     * Store a rendered entry for a URL path and update the tag index.
     */
    async set(path: string, entry: IsrCacheEntry): Promise<void> {
      const existingRaw = await withAbortTimeout(
        'get',
        signal => kv.get(pageKey(path), { type: 'text' }),
        timeoutMs,
        heartbeatMs,
      );
      let oldTags: readonly string[] = [];
      if (existingRaw !== null) {
        try {
          const existing = JSON.parse(existingRaw) as IsrCacheEntry;
          oldTags = existing.tags;
        } catch {
          oldTags = [];
        }
      }

      const newTags = entry.tags;
      // De-duplicate new tags — a page tagged ['posts', 'posts'] should record
      // a single entry in the tag index, not duplicates.
      const newTagSet = new Set(newTags);
      const oldTagSet = new Set(oldTags);

      const removedTags = [...oldTagSet].filter(t => !newTagSet.has(t));
      const addedTags = [...newTagSet].filter(t => !oldTagSet.has(t));

      // Account for the page-write subrequest in the concurrency budget. The
      // page write and tag-index fan-out share Cloudflare's 50 subrequest cap;
      // running the page put outside the limiter would let large tag counts
      // burst past the ceiling. We reserve one slot for the page op by capping
      // the tag fan-out concurrency at `concurrency - 1` (min 1).
      const pageOp = (): Promise<void> =>
        withAbortTimeout(
          'put',
          signal => kv.put(pageKey(path), JSON.stringify(entry)),
          timeoutMs,
          heartbeatMs,
        );
      const tagOps = [
        ...removedTags.map(tag => () => removeFromTagIndex(kv, tag, path, timeoutMs, heartbeatMs)),
        ...addedTags.map(tag => () => updateTagIndex(kv, tag, path, timeoutMs, heartbeatMs)),
      ];
      // Batch the page write together with tag-index writes under the same
      // concurrency cap. With 100+ tags an unbounded Promise.all would burn
      // through Cloudflare's 50-subrequest budget in a single invocation.
      await runWithConcurrency([pageOp, ...tagOps], concurrency);
    },

    /**
     * Remove the cached entry for a specific URL path.
     *
     * Does not clean up tag index entries — stale tag references are harmless:
     * `invalidateTag` will skip missing page keys without error.
     *
     * @param path - The URL pathname to invalidate.
     */
    async invalidatePath(path: string): Promise<void> {
      await withAbortTimeout(
        'delete',
        signal => kv.delete(pageKey(path)),
        timeoutMs,
        heartbeatMs,
      );
    },

    /**
     * Remove all cached entries tagged with the given tag.
     */
    async invalidateTag(tag: string): Promise<void> {
      const indexKey = tagKey(tag);
      const raw = await withAbortTimeout(
        'get',
        signal => kv.get(indexKey, { type: 'text' }),
        timeoutMs,
        heartbeatMs,
      );
      if (raw === null) return;

      let paths: string[];
      try {
        paths = JSON.parse(raw) as string[];
      } catch {
        await withAbortTimeout(
          'delete',
          signal => kv.delete(indexKey),
          timeoutMs,
          heartbeatMs,
        );
        return;
      }

      await runWithConcurrency(
        paths.map(
          p => () =>
            withAbortTimeout(
              'delete',
              signal => kv.delete(pageKey(p)),
              timeoutMs,
              heartbeatMs,
            ),
        ),
        concurrency,
      );
      await withAbortTimeout(
        'delete',
        signal => kv.delete(indexKey),
        timeoutMs,
        heartbeatMs,
      );
    },
  };
}
