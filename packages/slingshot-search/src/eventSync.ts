/**
 * Event-bus sync manager.
 *
 * Manages event-bus subscriptions for entities with `syncMode: 'event-bus'`.
 * Supports config-driven entities discovered via the entity registry.
 *
 * Batches indexing operations with a configurable flush interval and queue
 * size threshold. Deletions are flushed immediately to avoid stale data.
 *
 * All state is closure-owned — no module-level mutable state.
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
  GeoSearchConfig,
  HealthCheck,
  HealthReport,
  HookServices,
  Logger,
  MetricsEmitter,
  ResolvedEntityConfig,
  SlingshotEventBus,
  SlingshotEvents,
} from '@lastshotlabs/slingshot-core';
import { createNoopMetricsEmitter, noopLogger } from '@lastshotlabs/slingshot-core';
import { applyGeoTransformDetailed } from './geoTransform';
import type { SearchManager } from './searchManager';
import type { SearchTransformRegistry } from './transformRegistry';
import type { SearchPluginConfig } from './types/config';
import type { SearchProvider } from './types/provider';

// ============================================================================
// DLQ store contract (P-SEARCH-5)
// ============================================================================

/**
 * Pluggable adapter for dead-letter persistence. The default implementation is
 * in-memory and bounded; durable backends (Redis, Postgres) implement the same
 * shape so DLQ entries survive process restarts.
 *
 * All methods may throw — the event-sync manager treats DLQ-store failures as
 * non-fatal (DLQ promotion is not aborted) and logs the failure via Logger.
 */
export interface DlqStore {
  /** Persist a dead-letter entry. Idempotent on `(indexName, documentId)`. */
  put(entry: FlushDeadLetterEntry): Promise<void>;
  /** Snapshot of every retained entry. Used for `getDeadLetters()`. */
  getAll(): Promise<ReadonlyArray<FlushDeadLetterEntry>>;
  /** Remove a single entry by its composite key. */
  delete(indexName: string, documentId: string): Promise<void>;
}

/** Internal sync handle exposed by the in-memory DLQ store for fast paths. */
interface InMemoryDlqStore extends DlqStore {
  readonly kind: 'in-memory';
  putSync(entry: FlushDeadLetterEntry): { evicted: FlushDeadLetterEntry | null };
  size(): number;
  snapshotSync(): ReadonlyArray<FlushDeadLetterEntry>;
  clearSync(): void;
}

/**
 * Build the default in-memory DLQ store. Bounded by `maxEntries`; FIFO-evicts
 * the oldest entry when the limit is exceeded. The evicted entry is returned
 * from `putSync()` so the manager can emit the structured `search:dlq.evicted`
 * event without polling the store.
 */
function createInMemoryDlqStore(maxEntries: number): InMemoryDlqStore {
  const entries = new Map<string, Map<string, FlushDeadLetterEntry>>();
  const insertionOrder: Array<{ indexName: string; documentId: string }> = [];
  let count = 0;

  function key(indexName: string, documentId: string): string {
    return `${indexName} ${documentId}`;
  }

  return {
    kind: 'in-memory',
    putSync(entry) {
      let perIndex = entries.get(entry.indexName);
      if (!perIndex) {
        perIndex = new Map();
        entries.set(entry.indexName, perIndex);
      }
      const replacingExisting = perIndex.has(entry.documentId);
      perIndex.set(entry.documentId, entry);
      if (!replacingExisting) {
        insertionOrder.push({ indexName: entry.indexName, documentId: entry.documentId });
        count += 1;
      }
      let evicted: FlushDeadLetterEntry | null = null;
      while (count > maxEntries && insertionOrder.length > 0) {
        const oldest = insertionOrder.shift();
        if (!oldest) break;
        const oldestPerIndex = entries.get(oldest.indexName);
        if (!oldestPerIndex) continue;
        const droppedEntry = oldestPerIndex.get(oldest.documentId);
        if (!oldestPerIndex.delete(oldest.documentId)) continue;
        if (oldestPerIndex.size === 0) entries.delete(oldest.indexName);
        count -= 1;
        if (droppedEntry) evicted = droppedEntry;
      }
      // Reference key for parity with future durable adapters that key off of it.
      void key;
      return { evicted };
    },
    size() {
      return count;
    },
    snapshotSync() {
      const out: FlushDeadLetterEntry[] = [];
      for (const indexMap of entries.values()) {
        for (const entry of indexMap.values()) out.push(entry);
      }
      return out;
    },
    clearSync() {
      entries.clear();
      insertionOrder.length = 0;
      count = 0;
    },
    put(entry) {
      this.putSync(entry);
      return Promise.resolve();
    },
    getAll() {
      return Promise.resolve(this.snapshotSync());
    },
    delete(indexName, documentId) {
      const perIndex = entries.get(indexName);
      if (!perIndex) return Promise.resolve();
      if (perIndex.delete(documentId)) {
        if (perIndex.size === 0) entries.delete(indexName);
        count -= 1;
        // Lazily filter the FIFO queue. We accept the O(n) scan because explicit
        // deletes are rare relative to puts; the queue stays bounded by maxEntries.
        const idx = insertionOrder.findIndex(
          e => e.indexName === indexName && e.documentId === documentId,
        );
        if (idx >= 0) insertionOrder.splice(idx, 1);
      }
      return Promise.resolve();
    },
  };
}

// ============================================================================
// File-backed DLQ store (durable across restarts)
// ============================================================================

/**
 * Configuration for {@link createFileDlqStore}.
 */
export interface FileDlqStoreConfig {
  /** Path to the JSON-lines file for persisting dead-letter entries. */
  readonly storagePath: string;
  /**
   * Maximum number of entries before the file is compacted (deduplicated).
   * Default: `1024`.
   */
  readonly maxEntries?: number;
}

/**
 * Durable DLQ store that persists entries to a JSON-lines file.
 *
 * Entries are appended to the file immediately on `put()`. On construction
 * (first `put` or `getAll`), any existing entries are reloaded from disk.
 *
 * Supports `replayDlq()` which iterates each stored entry through a
 * caller-provided handler and removes successfully handled entries from the
 * file.
 */
export interface FileDlqStore extends DlqStore {
  readonly kind: 'file';

  /**
   * Iterate every stored entry through `handler`. When `handler` returns
   * `true` for an entry, that entry is removed from the file. When `handler`
   * returns `false` or throws, the entry is retained.
   *
   * After the iteration completes the file is rewritten with only the
   * retained (failed) entries, effectively compacting it.
   */
  replayDlq(
    handler: (entry: FlushDeadLetterEntry) => Promise<boolean>,
  ): Promise<{ processed: number; failed: number; total: number }>;

  /** Return the current entry count by reading the file. */
  size(): Promise<number>;

  /** Remove every entry and delete the file. */
  clear(): Promise<void>;
}

/**
 * Create a durable, file-backed dead-letter store.
 *
 * Entries are persisted as JSON-lines (one `FlushDeadLetterEntry` per line)
 * so the file is human-readable and trivially greppable in production.
 *
 * @param config - Storage path and optional compaction threshold.
 * @returns A `FileDlqStore` instance. Call `replayDlq()` to re-process stored
 *   entries.
 */
export function createFileDlqStore(config: FileDlqStoreConfig): FileDlqStore {
  const { storagePath: filePath, maxEntries = 1024 } = config;

  function ensureDir(): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  function readLines(): FlushDeadLetterEntry[] {
    try {
      if (!fs.existsSync(filePath)) return [];
      const content = fs.readFileSync(filePath, 'utf-8');
      if (!content.trim()) return [];
      return content
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => {
          try {
            return JSON.parse(line) as FlushDeadLetterEntry;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is FlushDeadLetterEntry => entry !== null);
    } catch {
      return [];
    }
  }

  function writeAll(entries: FlushDeadLetterEntry[]): void {
    if (entries.length === 0) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // best-effort
      }
      return;
    }
    ensureDir();
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(filePath, lines, 'utf-8');
  }

  function appendLine(entry: FlushDeadLetterEntry): void {
    ensureDir();
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(filePath, line, 'utf-8');
  }

  function compactIfNeeded(): void {
    try {
      const entries = readLines();
      if (entries.length >= maxEntries) {
        // Deduplicate by (indexName, documentId), keeping the latest
        const seen = new Map<string, FlushDeadLetterEntry>();
        for (const entry of entries) {
          const k = `${entry.indexName}\x00${entry.documentId}`;
          seen.set(k, entry);
        }
        writeAll(Array.from(seen.values()));
      }
    } catch {
      // best-effort
    }
  }

  const store: FileDlqStore = {
    kind: 'file',

    async put(entry: FlushDeadLetterEntry): Promise<void> {
      // Compact before appending so the entry count never exceeds maxEntries
      // after the write settles (P-DLQ-FILE-1).
      compactIfNeeded();
      appendLine(entry);
    },

    async getAll(): Promise<ReadonlyArray<FlushDeadLetterEntry>> {
      return readLines();
    },

    async delete(indexName: string, documentId: string): Promise<void> {
      const entries = readLines();
      const targetKey = `${indexName}\x00${documentId}`;
      const filtered = entries.filter(e => `${e.indexName}\x00${e.documentId}` !== targetKey);
      if (filtered.length < entries.length) {
        writeAll(filtered);
      }
    },

    async replayDlq(
      handler: (entry: FlushDeadLetterEntry) => Promise<boolean>,
    ): Promise<{ processed: number; failed: number; total: number }> {
      const entries = readLines();
      let processed = 0;
      let failed = 0;
      const results: boolean[] = [];

      for (const entry of entries) {
        try {
          const success = await handler(entry);
          results.push(success);
          if (success) processed++;
          else failed++;
        } catch {
          results.push(false);
          failed++;
        }
      }

      // Rewrite the file with only entries that the handler rejected or threw on.
      const remaining = entries.filter((_, i) => !results[i]);
      writeAll(remaining);

      return { processed, failed, total: entries.length };
    },

    async size(): Promise<number> {
      return readLines().length;
    },

    async clear(): Promise<void> {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // best-effort
      }
    },
  };

  return store;
}

// ============================================================================
// Token-bucket rate limiter (P-SEARCH-9)
// ============================================================================

/** Internal token-bucket gate used to throttle indexing operations. */
interface IndexRateLimiter {
  /**
   * Attempt to consume `n` tokens (one per indexing op).
   * Returns `'allowed'` when consumed; `'dropped'` when in `drop` overflow mode
   * and the bucket is empty; never resolves until tokens become available when
   * in `queue` overflow mode.
   */
  acquire(n: number): Promise<'allowed' | 'dropped'>;
  reset(): void;
}

function createIndexRateLimiter(
  maxOpsPerSecond: number,
  overflowMode: 'drop' | 'queue',
): IndexRateLimiter {
  const capacity = maxOpsPerSecond;
  const refillRatePerMs = maxOpsPerSecond / 1000;
  let tokens = capacity;
  let lastRefill = Date.now();

  function refill(): void {
    const now = Date.now();
    const elapsed = now - lastRefill;
    if (elapsed <= 0) return;
    tokens = Math.min(capacity, tokens + elapsed * refillRatePerMs);
    lastRefill = now;
  }

  return {
    async acquire(n: number): Promise<'allowed' | 'dropped'> {
      refill();
      if (tokens >= n) {
        tokens -= n;
        return 'allowed';
      }
      if (overflowMode === 'drop') {
        return 'dropped';
      }
      // queue mode: wait for tokens to accumulate.
      const deficit = n - tokens;
      const waitMs = Math.ceil(deficit / refillRatePerMs);
      await new Promise<void>(resolve => setTimeout(resolve, waitMs));
      refill();
      tokens = Math.max(0, tokens - n);
      return 'allowed';
    },
    reset() {
      tokens = capacity;
      lastRefill = Date.now();
    },
  };
}

// ============================================================================
// Types
// ============================================================================

/** Configuration for `createEventSyncManager()`. */
export interface EventSyncManagerConfig {
  /** Plugin-level search configuration used to resolve entity index names. */
  readonly pluginConfig: SearchPluginConfig;
  /** The search manager used to look up index names and provider instances. */
  readonly searchManager: SearchManager;
  /** Registry of named document transform functions. */
  readonly transformRegistry: SearchTransformRegistry;
  /** The application event bus to subscribe to entity CRUD events on. */
  readonly bus: SlingshotEventBus;
  /** Registry-backed event publisher used for package-owned search events. */
  readonly events?: SlingshotEvents;

  /**
   * Flush pending indexing operations after this interval in milliseconds.
   * Default: `5000` (5 seconds).
   */
  readonly flushIntervalMs?: number;

  /**
   * Flush when the total number of pending operations across all indexes
   * reaches this threshold. Default: `100`.
   */
  readonly flushThreshold?: number;

  /**
   * Maximum number of times a single (indexName, documentId) operation may
   * be re-queued after flush failures before it is sent to the dead-letter
   * channel via `search:sync.dead`. Default: `10`.
   */
  readonly maxFlushAttempts?: number;

  /**
   * Optional callback invoked synchronously when an operation is moved to the
   * dead-letter map after exceeding `maxFlushAttempts`. Useful for hooking up
   * external alerting or persistent DLQ storage. Errors thrown by the callback
   * are caught and logged — the dead-letter promotion is not aborted.
   */
  readonly onFlushDeadLetter?: (entry: FlushDeadLetterEntry, services?: HookServices) => void;
  /**
   * Late-bound accessor for framework {@link HookServices}. The plugin sets
   * this during `setupMiddleware`; the sync manager invokes it just before
   * each `onFlushDeadLetter` call so callbacks see current framework state.
   */
  readonly getHookServices?: () => HookServices | undefined;

  /**
   * Maximum number of dead-letter entries to retain in memory. When the count
   * exceeds this threshold the OLDEST entry (by FIFO insertion order) is
   * evicted to make room for the new one and `evictedFromDeadLetter` is
   * incremented on the health snapshot. Default: `10_000`.
   *
   * The dead-letter map is bounded so a flapping downstream cannot consume
   * unbounded memory. Persistent DLQ retention belongs to `onFlushDeadLetter`.
   */
  readonly maxDeadLetterEntries?: number;

  /**
   * When set, the manager uses a file-backed DLQ store at this path instead of
   * the default in-memory store. Entries survive process restarts and can be
   * re-processed via `replayDlq()`.
   *
   * Mutually exclusive with `dlqStore` — when both are set, `dlqStore` takes
   * precedence and a warning is logged.
   */
  readonly dlqStoragePath?: string;

  /**
   * Optional unified metrics emitter. When provided, the manager records
   * `search.eventSync.flush.count` (counter) on each flush attempt and
   * publishes `search.eventSync.dlq.size` (gauge) whenever the dead-letter
   * map changes. Defaults to a no-op emitter.
   */
  readonly metrics?: MetricsEmitter;

  /**
   * Structured logger handle. Used for non-fatal warnings (DLQ eviction,
   * skipped geo transforms, dropped index ops) so production deployments can
   * route the records to their log sink instead of bare `console.error`.
   * Defaults to `noopLogger` so unit tests stay quiet.
   */
  readonly logger?: Logger;

  /**
   * Optional pluggable dead-letter store. The default is in-memory and bounded
   * by `maxDeadLetterEntries`. Provide a durable backend (Redis, Postgres,
   * SQS, etc.) to retain DLQ entries across process restarts.
   *
   * When a custom store is provided, `maxDeadLetterEntries` only governs the
   * `getHealth().deadLetterCount` cache and per-operation snapshot — the
   * actual retention bound is the store's own contract.
   */
  readonly dlqStore?: DlqStore;

  /**
   * Maximum indexing operations per second issued to the provider during a
   * flush. Token-bucket gated; overflow behavior is controlled by
   * `indexOverflowMode`. Default: `1000`.
   *
   * The bucket is shared across indexes — the limit is global, not per-index.
   */
  readonly maxIndexOpsPerSecond?: number;

  /**
   * Behavior when the index rate-limit token bucket is empty.
   *
   * - `'queue'` (default) — wait for tokens to refill before issuing the op.
   *   Preserves at-least-once semantics at the cost of additional flush
   *   latency.
   * - `'drop'` — drop the operation, log via Logger.warn, and emit a
   *   `search:sync.failed` event. Pending state is restored so the next flush
   *   re-attempts the doc once the bucket has refilled.
   */
  readonly indexOverflowMode?: 'drop' | 'queue';
}

/** Public interface for an event-bus sync manager instance. */
export interface EventSyncManager extends HealthCheck {
  /**
   * Subscribe to CRUD events for a single config-driven entity.
   *
   * Has no effect if the entity has `syncMode !== 'event-bus'` or if this
   * entity's storage name has already been subscribed.
   *
   * @param entity - The resolved entity config to subscribe for.
   */
  subscribeConfigEntity(entity: ResolvedEntityConfig): void;

  /**
   * Subscribe to CRUD events for all config-driven entities with
   * `syncMode: 'event-bus'` in the provided list.
   *
   * Internally calls `subscribeConfigEntity()` for each entity; duplicates
   * are silently ignored.
   *
   * @param entities - The full list of resolved entity configs.
   */
  subscribeConfigEntities(entities: ReadonlyArray<ResolvedEntityConfig>): void;

  /**
   * Force-flush all pending indexing operations immediately.
   *
   * Useful in tests to ensure documents are indexed before assertions,
   * or during a graceful shutdown to minimise data loss. Concurrent
   * calls are deduplicated — if a flush is already in progress the
   * call returns without waiting for it to finish.
   */
  flush(): Promise<void>;

  /**
   * Gracefully tear down the sync manager.
   *
   * 1. Stops the periodic flush timer.
   * 2. Flushes all remaining pending operations.
   * 3. Unsubscribes all event listeners from the bus.
   * 4. Clears all internal state maps.
   *
   * After this call the manager is inoperable.
   */
  teardown(): Promise<void>;

  /**
   * Return a point-in-time health snapshot for observability.
   *
   * Implements the framework `HealthCheck` contract — the returned report
   * carries the same `pendingCount`, `deadLetterCount`, `flushing`, and
   * eviction counters in `details` plus the canonical `state` / `component`
   * fields used by aggregators.
   */
  getHealth(): HealthReport;

  /**
   * Detailed event-sync health snapshot. Same data as {@link getHealth} but
   * typed as the package-specific shape rather than the generic
   * `HealthReport`.
   */
  getEventSyncHealth(): EventSyncHealth;

  /**
   * Snapshot of the dead-letter map. Returns a frozen array of entries — the
   * underlying map is not exposed by reference so callers can safely iterate
   * without observing concurrent mutations.
   */
  getDeadLetters(): ReadonlyArray<FlushDeadLetterEntry>;

  /**
   * Re-process every stored dead-letter entry.
   *
   * For each entry, `replayDlq` attempts to re-perform the operation (index or
   * delete) through the original provider. Entries whose operation succeeds are
   * removed from the store; entries that fail again are retained.
   *
   * **Index operations** — The DLQ entry only stores the `documentId`, not the
   * full document body. For 'index' entries, `replayDlq` re-enqueues a delete
   * placeholder into the pending queue so the next flush will attempt to re-index
   * if a newer version of the document arrives via the event bus before the
   * flush runs. For 'delete' entries, the provider's `deleteDocuments` is called
   * directly.
   *
   * Returns a summary of how many entries were successfully processed, how many
   * failed, and the total processed.
   *
   * @throws Never — errors during individual entry processing are caught and
   *   counted in the `failed` tally.
   */
  replayDlq(): Promise<{ processed: number; failed: number; total: number }>;
}

type PendingAction =
  | {
      readonly type: 'index';
      readonly document: Record<string, unknown>;
      /** Number of failed flush attempts already made for this op. */
      readonly attempts: number;
      /**
       * Monotonic timestamp (from a closure-owned counter) recording when this
       * op was most recently enqueued via `addPending`. Used during restore to
       * never overwrite a newer pending op with an older snapshot op when both
       * exist after an in-flight flush failure.
       */
      readonly writeTs: number;
    }
  | {
      readonly type: 'delete';
      readonly attempts: number;
      readonly writeTs: number;
    };

/** Per-index metadata stored alongside pending operations. */
interface IndexSyncState {
  readonly entityName: string;
  readonly pkField: string;
  readonly provider: SearchProvider;
  readonly geoConfig?: GeoSearchConfig;
}

/** Health snapshot exposed via `EventSyncManager.getEventSyncHealth()`. */
export interface EventSyncHealth {
  /** Number of operations currently waiting in the pending queue (across all indexes). */
  readonly pendingCount: number;
  /** Number of operations currently in the dead-letter map. */
  readonly deadLetterCount: number;
  /** Number of operations currently in the dead-letter map (alias for `deadLetterCount`). */
  readonly dlqCount: number;
  /** Whether a flush is currently in progress. */
  readonly flushing: boolean;
  /**
   * Cumulative count of dead-letter entries evicted because the in-memory map
   * exceeded `maxDeadLetterEntries`. Monotonic — never decreases over the
   * lifetime of the manager.
   */
  readonly evictedFromDeadLetter: number;
  /**
   * Wall-clock millisecond timestamp of the most recent flush attempt
   * completion (success or failure). `null` until the first flush has run.
   */
  readonly lastFlushAt: number | null;
  /**
   * Last error message produced by a flush attempt. Cleared on the next
   * successful flush. `null` when the most recent flush did not raise an
   * error.
   */
  readonly lastError: string | null;
  /**
   * Cumulative count of indexing operations dropped because the rate-limit
   * token bucket was empty and `indexOverflowMode === 'drop'`.
   */
  readonly droppedFromRateLimit: number;
}

/** A single dead-lettered op kept in memory after exhausting `maxFlushAttempts`. */
export interface FlushDeadLetterEntry {
  readonly indexName: string;
  readonly entityName: string;
  readonly documentId: string;
  readonly operation: 'index' | 'delete';
  readonly attempts: number;
  readonly error: string;
  readonly enqueuedAt: number;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an event-bus sync manager that keeps search indexes current by
 * consuming entity CRUD events emitted by the framework event bus.
 *
 * When an entity is configured with `syncMode: 'event-bus'`, the search plugin
 * creates one of these managers and calls `subscribeConfigEntities()` in its
 * `setupPost` lifecycle phase. From that point the manager listens for
 * `entity:<storageName>.created`, `.updated`, and `.deleted` events and
 * forwards them to the appropriate search provider.
 *
 * **Batching** — index operations are queued and flushed either on a timer
 * (`flushIntervalMs`, default 5 s) or when the total pending queue reaches a
 * threshold (`flushThreshold`, default 100 documents). Deletions bypass the
 * batch queue and are flushed immediately to prevent stale results.
 *
 * **Idempotency** — the pending queue is keyed by `(indexName, documentId)`.
 * If the same document is created/updated multiple times before a flush, only
 * the most recent version is sent to the provider. This collapses rapid
 * updates into a single index call.
 *
 * **Geo transforms** — when the entity's search config includes a `geo` field
 * mapping, `applyGeoTransform()` is called before queuing the document so the
 * provider receives the composite `_geo: { lat, lng }` field expected by
 * Meilisearch and other providers.
 *
 * @param config - Manager configuration including the plugin config, search
 *   manager, transform registry, event bus, and optional flush tuning.
 * @returns An `EventSyncManager` instance with subscription and lifecycle
 *   methods. Call `teardown()` to flush remaining operations, unsubscribe
 *   all listeners, and clear internal state.
 *
 * @remarks
 * **Eventual consistency** — sync is asynchronous and not transactional. A
 * document written to the primary store will be visible in search only after
 * the next flush cycle completes. Under normal conditions this lag is at most
 * `flushIntervalMs` milliseconds. If the provider is temporarily unavailable,
 * the flush will log an error and emit a `search:sync.failed` event, but the
 * pending queue entry is lost — there is no retry mechanism or dead-letter
 * queue.
 *
 * **Cross-app isolation** — all state is closure-owned. Multiple calls to
 * `createEventSyncManager()` return completely independent instances with no
 * shared state.
 *
 * **Entity deduplication** — calling `subscribeConfigEntity()` for the same
 * storage name more than once is a no-op (guarded by `subscribedConfigEntities`
 * set).
 *
 * @example
 * ```ts
 * import { createEventSyncManager } from '@lastshotlabs/slingshot-search';
 *
 * const eventSync = createEventSyncManager({
 *   pluginConfig,
 *   searchManager,
 *   transformRegistry,
 *   bus,
 *   flushIntervalMs: 3000,
 *   flushThreshold: 50,
 * });
 *
 * // Subscribe to all entities with syncMode: 'event-bus'
 * eventSync.subscribeConfigEntities(resolvedEntities);
 *
 * // Later, on graceful shutdown:
 * await eventSync.teardown();
 * ```
 */
export function createEventSyncManager(config: EventSyncManagerConfig): EventSyncManager {
  const {
    searchManager,
    transformRegistry,
    bus,
    events,
    flushIntervalMs = 5000,
    flushThreshold = 100,
    maxFlushAttempts = 10,
    onFlushDeadLetter,
    getHookServices,
    maxDeadLetterEntries = 10_000,
    maxIndexOpsPerSecond = 1000,
    indexOverflowMode = 'queue',
  } = config;
  const metrics: MetricsEmitter = config.metrics ?? createNoopMetricsEmitter();
  const logger: Logger = config.logger ?? noopLogger;

  // Closure-owned state
  const unsubscribers: Array<() => void> = [];
  const pending = new Map<string, Map<string, PendingAction>>();
  const indexStates = new Map<string, IndexSyncState>();
  const subscribedConfigEntities = new Set<string>();
  // Pluggable DLQ store. Default is an in-memory store bounded by
  // `maxDeadLetterEntries`; durable backends (file, Redis, Postgres) implement
  // the same shape so DLQ entries can survive process restarts.
  const defaultDlqStore = createInMemoryDlqStore(maxDeadLetterEntries);
  const dlqStoragePath = config.dlqStoragePath;
  const hasDlqStoreOverride = config.dlqStore !== undefined;
  const hasDlqStoragePath = dlqStoragePath !== undefined && dlqStoragePath.length > 0;
  let fileDlqStore: FileDlqStore | undefined;

  if (hasDlqStoreOverride && hasDlqStoragePath) {
    logger.warn(
      'event-sync both dlqStore and dlqStoragePath are configured; dlqStore takes precedence, ignoring dlqStoragePath',
      { component: 'slingshot-search.eventSync' },
    );
  }

  let dlqStore: DlqStore;
  let isInMemoryDlq: boolean;

  if (hasDlqStoreOverride && config.dlqStore) {
    dlqStore = config.dlqStore;
    isInMemoryDlq = false;
  } else if (hasDlqStoragePath && dlqStoragePath) {
    fileDlqStore = createFileDlqStore({
      storagePath: dlqStoragePath,
      maxEntries: maxDeadLetterEntries,
    });
    dlqStore = fileDlqStore;
    isInMemoryDlq = false;
  } else {
    dlqStore = defaultDlqStore;
    isInMemoryDlq = true;
  }
  // Cache of the last-known DLQ count for synchronous health snapshots. Kept
  // in lock-step with `dlqStore` writes via the in-memory fast path; durable
  // adapters update it via `refreshDlqCount()` after async puts.
  let deadLetterCount = 0;
  let evictedFromDeadLetter = 0;
  let droppedFromRateLimit = 0;
  let lastFlushAt: number | null = null;
  let lastError: string | null = null;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let flushing = false;
  let flushRequested = false;
  let tornDown = false;
  // Token bucket for index-rate limiting. Lazily created on first use so an
  // unconfigured manager (rate-limit unused) doesn't pay the allocation.
  const rateLimiter: IndexRateLimiter = createIndexRateLimiter(
    maxIndexOpsPerSecond,
    indexOverflowMode,
  );
  // Track the in-flight flush so `teardown()` can await it. The interval-tick
  // path attaches its promise here so disposal cannot race with state clear
  // (P-SEARCH-6).
  let inFlightFlush: Promise<void> | null = null;
  // Monotonic counter — never resets, never reused — used to mark per-doc
  // write timestamps so restore-pending can detect newer-vs-older ops.
  let writeTsCounter = 0;
  function nextWriteTs(): number {
    writeTsCounter += 1;
    return writeTsCounter;
  }

  // Entity CRUD events use dynamic string keys (e.g., 'entity:users.created').
  // SlingshotEventBus's `on(string, ...)` overload accepts these directly —
  // no cast needed. Alias kept for readability at call sites.
  const dynamicBus = bus;

  // -------------------------------------------------------------------------
  // Pending queue management
  // -------------------------------------------------------------------------

  function ensureFlushTimer(): void {
    if (flushTimer || tornDown) return;
    flushTimer = setInterval(() => {
      // Guard against late firings — clearInterval is best-effort but the
      // interval can race with a teardown that ran between scheduling and
      // dispatch. Any flush after teardown is a no-op.
      if (tornDown) return;
      // Track the in-flight promise so teardown can await it (P-SEARCH-6).
      // The catch handler logs and absorbs errors so the interval never
      // emits an unhandled rejection.
      const p = flushPending().catch((err: unknown) => {
        logger.error('event-sync flush error', {
          component: 'slingshot-search.eventSync',
          err: err instanceof Error ? err.message : String(err),
        });
      });
      inFlightFlush = p;
      void p.finally(() => {
        if (inFlightFlush === p) inFlightFlush = null;
      });
    }, flushIntervalMs);
  }

  function addPending(indexName: string, documentId: string, action: PendingAction): void {
    let indexPending = pending.get(indexName);
    if (!indexPending) {
      indexPending = new Map();
      pending.set(indexName, indexPending);
    }
    indexPending.set(documentId, action);

    // Deletions flush immediately
    if (action.type === 'delete') {
      requestFlush('[slingshot-search:event-sync] Immediate delete flush error:');
      return;
    }

    // Check threshold
    let totalPending = 0;
    for (const indexMap of pending.values()) {
      totalPending += indexMap.size;
    }
    if (totalPending >= flushThreshold) {
      requestFlush('[slingshot-search:event-sync] Threshold flush error:');
    }
  }

  function requestFlush(errorContext: string): void {
    if (flushing) {
      flushRequested = true;
      return;
    }
    const p = flushPending().catch((err: unknown) => {
      logger.error('event-sync flush error', {
        component: 'slingshot-search.eventSync',
        context: errorContext,
        err: err instanceof Error ? err.message : String(err),
      });
    });
    // Track immediate flushes too so teardown can await them (P-SEARCH-6).
    inFlightFlush = p;
    void p.finally(() => {
      if (inFlightFlush === p) inFlightFlush = null;
    });
  }

  async function flushPending(): Promise<void> {
    // Guard against concurrent flushes. We do NOT short-circuit on `tornDown`
    // here because `teardown()` deliberately calls `flushPending()` once after
    // setting the flag to drain remaining operations. Mid-flight ticks should
    // however bail out at every async hop below so they don't continue past
    // a late-arriving teardown.
    if (flushing) return;
    flushing = true;
    flushRequested = false;
    // Counter increments unconditionally so dashboards can observe flush
    // cadence and infer health from rate changes (failures don't suppress
    // attempts). One increment per flush attempt, not per per-index batch.
    metrics.counter('search.eventSync.flush.count');
    let flushHadError = false;

    try {
      // Snapshot and clear pending queue atomically
      const snapshot = new Map<string, Map<string, PendingAction>>();
      for (const [indexName, actions] of pending) {
        if (actions.size > 0) {
          snapshot.set(indexName, new Map(actions));
          actions.clear();
        }
      }

      for (const [indexName, actions] of snapshot) {
        const state = indexStates.get(indexName);
        if (!state) {
          logger.error('event-sync no sync state for index, dropping operations', {
            component: 'slingshot-search.eventSync',
            indexName,
            droppedOps: actions.size,
          });
          continue;
        }

        const toIndex: Array<Record<string, unknown>> = [];
        const toDelete: string[] = [];
        const indexedDocIds: string[] = [];

        // Apply rate limiting BEFORE we shape the per-op batches. Indexing ops
        // are gated by the token bucket; deletes pass through untouched
        // because they are correctness-critical (stale reads must be evicted
        // promptly and the volume is generally small).
        for (const [docId, action] of actions) {
          if (action.type === 'index') {
            const decision = await rateLimiter.acquire(1);
            if (decision === 'dropped') {
              droppedFromRateLimit += 1;
              // Restore so the next flush picks it up after the bucket refills.
              let indexPending = pending.get(indexName);
              if (!indexPending) {
                indexPending = new Map();
                pending.set(indexName, indexPending);
              }
              const existing = indexPending.get(docId);
              if (!existing || existing.writeTs < action.writeTs) {
                indexPending.set(docId, action);
              }
              logger.warn('event-sync index op dropped by rate limiter', {
                component: 'slingshot-search.eventSync',
                indexName,
                documentId: docId,
              });
              emitSyncFailed(
                indexName,
                state.entityName,
                docId,
                new Error('rate-limit overflow: index op dropped'),
              );
              continue;
            }
            toIndex.push(action.document);
            indexedDocIds.push(docId);
          } else {
            toDelete.push(docId);
          }
        }

        // Process deletions
        if (toDelete.length > 0) {
          try {
            await state.provider.deleteDocuments(indexName, toDelete);
            // Re-check teardown after the await — a teardown may have raced
            // with the in-flight provider call. We must not push restored
            // entries or emit further events after the manager is shut down.
            if (tornDown) return;
          } catch (err) {
            // Re-check teardown before mutating state in the catch path too —
            // if the provider rejected late and teardown ran in the meantime,
            // restoring entries would resurrect state the caller has already
            // dropped via clear().
            if (tornDown) return;
            flushHadError = true;
            lastError = err instanceof Error ? err.message : String(err);
            logger.error('event-sync failed to delete documents', {
              component: 'slingshot-search.eventSync',
              indexName,
              count: toDelete.length,
              err: lastError,
            });
            // Restore failed deletions to pending so the next flush retries them.
            // Invariant: never overwrite a NEWER pending op with an OLDER snapshot
            // op. A new event may have arrived for the same docId while this
            // flush was in flight; that newer entry carries a higher `writeTs`
            // than the one captured in `actions`. We compare timestamps and
            // only restore when the existing entry is missing or older.
            let indexPending = pending.get(indexName);
            if (!indexPending) {
              indexPending = new Map();
              pending.set(indexName, indexPending);
            }
            for (const docId of toDelete) {
              const failedAction = actions.get(docId);
              if (!failedAction) continue;
              const existing = indexPending.get(docId);
              if (existing && existing.writeTs >= failedAction.writeTs) continue;
              const nextAttempts = failedAction.attempts + 1;
              if (nextAttempts >= maxFlushAttempts) {
                recordDeadLetter(indexName, state.entityName, docId, 'delete', err, nextAttempts);
                continue;
              }
              indexPending.set(docId, { ...failedAction, attempts: nextAttempts });
            }
            emitSyncFailed(indexName, state.entityName, undefined, err);
          }
        }

        // If teardown happened between the deletions and the indexes, abort
        // before issuing more provider work.
        if (tornDown) return;

        // Process indexes
        if (toIndex.length > 0) {
          try {
            await state.provider.indexDocuments(indexName, toIndex, state.pkField);
            // Same teardown re-check as the delete branch — a successful
            // provider call after teardown still must not emit follow-up state.
            if (tornDown) return;
          } catch (err) {
            if (tornDown) return;
            flushHadError = true;
            lastError = err instanceof Error ? err.message : String(err);
            logger.error('event-sync failed to index documents', {
              component: 'slingshot-search.eventSync',
              indexName,
              count: toIndex.length,
              err: lastError,
            });
            // Same invariant as the delete branch above — compare per-doc
            // `writeTs` to avoid clobbering a newer pending op with this
            // older snapshot one, and DLQ on retry-budget exhaustion.
            let indexPending = pending.get(indexName);
            if (!indexPending) {
              indexPending = new Map();
              pending.set(indexName, indexPending);
            }
            // Only restore docs that we actually attempted to send. Rate-limit
            // dropped docs are already restored above.
            const indexedSet = new Set(indexedDocIds);
            for (const [docId, action] of actions) {
              if (action.type !== 'index') continue;
              if (!indexedSet.has(docId)) continue;
              const existing = indexPending.get(docId);
              if (existing && existing.writeTs >= action.writeTs) continue;
              const nextAttempts = action.attempts + 1;
              if (nextAttempts >= maxFlushAttempts) {
                recordDeadLetter(indexName, state.entityName, docId, 'index', err, nextAttempts);
                continue;
              }
              indexPending.set(docId, { ...action, attempts: nextAttempts });
            }
            emitSyncFailed(indexName, state.entityName, undefined, err);
          }
        }
      }
    } finally {
      flushing = false;
      lastFlushAt = Date.now();
      if (!flushHadError) lastError = null;
      if (flushRequested && pending.size > 0 && !tornDown) {
        flushRequested = false;
        const followup = flushPending().catch((err: unknown) => {
          logger.error('event-sync follow-up flush error', {
            component: 'slingshot-search.eventSync',
            err: err instanceof Error ? err.message : String(err),
          });
        });
        inFlightFlush = followup;
        void followup.finally(() => {
          if (inFlightFlush === followup) inFlightFlush = null;
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function emitSyncFailed(
    indexName: string,
    entityName: string,
    documentId: string | undefined,
    err: unknown,
  ): void {
    if (!events) return;
    (events.publish as (key: string, payload: unknown, opts?: unknown) => void)(
      'search:sync.failed',
      {
        indexName,
        documentId,
        entityName,
        error: err instanceof Error ? err.message : String(err),
        syncMode: 'event-bus',
      },
      // System-source background sync — no originating HTTP request, no actor.
      { source: 'system', requestTenantId: null },
    );
  }

  function emitSyncDead(
    indexName: string,
    entityName: string,
    documentId: string,
    operation: 'index' | 'delete',
    err: unknown,
    attempts: number,
  ): void {
    logger.error('event-sync DLQ promotion', {
      component: 'slingshot-search.eventSync',
      indexName,
      documentId,
      operation,
      attempts,
      err: err instanceof Error ? err.message : String(err),
    });
    if (!events) return;
    (events.publish as (key: string, payload: unknown, opts?: unknown) => void)(
      'search:sync.dead',
      {
        indexName,
        documentId,
        entityName,
        operation,
        attempts,
        error: err instanceof Error ? err.message : String(err),
        syncMode: 'event-bus',
      },
      { source: 'system', requestTenantId: null },
    );
  }

  function emitDlqEvicted(entry: FlushDeadLetterEntry): void {
    logger.error('event-sync DLQ entry evicted by capacity bound', {
      component: 'slingshot-search.eventSync',
      indexName: entry.indexName,
      documentId: entry.documentId,
      operation: entry.operation,
      attempts: entry.attempts,
      reason: 'capacity',
      err: entry.error,
    });
    if (!events) return;
    (events.publish as (key: string, payload: unknown, opts?: unknown) => void)(
      'search:dlq.evicted',
      {
        indexName: entry.indexName,
        documentId: entry.documentId,
        entityName: entry.entityName,
        operation: entry.operation,
        attempts: entry.attempts,
        error: entry.error,
        reason: 'capacity',
      },
      { source: 'system', requestTenantId: null },
    );
  }

  function emitGeoTransformSkipped(
    indexName: string,
    entityName: string,
    documentId: string,
    geoConfig: GeoSearchConfig,
    reason: 'missingLat' | 'missingLng' | 'missingBoth',
  ): void {
    logger.warn('event-sync geo transform skipped', {
      component: 'slingshot-search.eventSync',
      indexName,
      entityName,
      documentId,
      latField: geoConfig.latField,
      lngField: geoConfig.lngField,
      reason,
    });
    if (!events) return;
    (events.publish as (key: string, payload: unknown, opts?: unknown) => void)(
      'search:geoTransform.skipped',
      {
        indexName,
        entityName,
        documentId,
        latField: geoConfig.latField,
        lngField: geoConfig.lngField,
        reason,
      },
      { source: 'system', requestTenantId: null },
    );
  }

  /**
   * Move an op past the retry budget into the dead-letter store and fire the
   * structured `search:sync.dead` event plus the optional `onFlushDeadLetter`
   * callback. When the in-memory store is bounded and an existing entry is
   * evicted, a `search:dlq.evicted` event is emitted with the evicted payload.
   *
   * Any exceptions raised by the callback or the DLQ store are caught and
   * logged so DLQ promotion is never aborted.
   */
  function recordDeadLetter(
    indexName: string,
    entityName: string,
    documentId: string,
    operation: 'index' | 'delete',
    err: unknown,
    attempts: number,
  ): void {
    const entry: FlushDeadLetterEntry = {
      indexName,
      entityName,
      documentId,
      operation,
      attempts,
      error: err instanceof Error ? err.message : String(err),
      enqueuedAt: Date.now(),
    };

    if (isInMemoryDlq) {
      const { evicted } = defaultDlqStore.putSync(entry);
      if (evicted) {
        evictedFromDeadLetter += 1;
        emitDlqEvicted(evicted);
      }
      deadLetterCount = defaultDlqStore.size();
    } else {
      // Async path for durable stores. We optimistically increment the cached
      // count; refreshDlqCount() reconciles after the put settles.
      deadLetterCount += 1;
      void Promise.resolve(dlqStore.put(entry))
        .catch(storeErr => {
          logger.error('event-sync DLQ store put failed', {
            component: 'slingshot-search.eventSync',
            indexName,
            documentId,
            err: storeErr instanceof Error ? storeErr.message : String(storeErr),
          });
        })
        .finally(() => {
          // Best-effort recount so health reflects reality after the put.
          void refreshDlqCount();
        });
    }

    // Publish the current DLQ depth as a gauge. Done after eviction so the
    // value reflects the bounded steady-state size, not the transient peak.
    metrics.gauge('search.eventSync.dlq.size', deadLetterCount);

    emitSyncDead(indexName, entityName, documentId, operation, err, attempts);

    if (onFlushDeadLetter) {
      try {
        onFlushDeadLetter(entry, getHookServices?.());
      } catch (cbErr) {
        logger.error('event-sync onFlushDeadLetter callback error', {
          component: 'slingshot-search.eventSync',
          err: cbErr instanceof Error ? cbErr.message : String(cbErr),
        });
      }
    }
  }

  async function refreshDlqCount(): Promise<void> {
    try {
      const all = await dlqStore.getAll();
      deadLetterCount = all.length;
      metrics.gauge('search.eventSync.dlq.size', deadLetterCount);
    } catch {
      // best-effort — leave the cached count alone
    }
  }

  // -------------------------------------------------------------------------
  // Config-driven entity subscriptions
  // -------------------------------------------------------------------------

  function subscribeConfigEntity(entity: ResolvedEntityConfig): void {
    if (!entity.search || entity.search.syncMode !== 'event-bus') return;

    const storageName = entity._storageName;
    if (subscribedConfigEntities.has(storageName)) return;

    const indexName = searchManager.getIndexName(storageName);
    if (!indexName) return;

    const provider = searchManager.getProvider(storageName);
    if (!provider) return;

    const transformFn = transformRegistry.resolve(entity.search.transform);

    const geoConfig = entity.search.geo;

    indexStates.set(indexName, {
      entityName: entity.name,
      pkField: entity._pkField,
      provider,
      geoConfig,
    });

    const createdEvent = `entity:${storageName}.created`;
    const updatedEvent = `entity:${storageName}.updated`;
    const deletedEvent = `entity:${storageName}.deleted`;

    const onCreatedOrUpdated = (payload: unknown) => {
      try {
        const { id, document } = payload as {
          id: string;
          document: Record<string, unknown>;
        };
        let transformed = transformFn(document);
        if (geoConfig) {
          const geoOutcome = applyGeoTransformDetailed(transformed, geoConfig);
          if (geoOutcome.applied) {
            transformed = geoOutcome.document;
          } else {
            // P-SEARCH-8: surface the silent skip as a structured warn + event.
            emitGeoTransformSkipped(indexName, entity.name, id, geoConfig, geoOutcome.reason);
            transformed = geoOutcome.document;
          }
        }
        // Reset attempts on every fresh event — a new write supersedes any
        // prior failed attempts at the same docId. The new `writeTs` is
        // strictly greater than any previously emitted op so restore-pending
        // can detect the ordering.
        addPending(indexName, id, {
          type: 'index',
          document: transformed,
          attempts: 0,
          writeTs: nextWriteTs(),
        });
      } catch (err) {
        logger.error('event-sync error processing create/update', {
          component: 'slingshot-search.eventSync',
          storageName,
          err: err instanceof Error ? err.message : String(err),
        });
        emitSyncFailed(indexName, entity.name, undefined, err);
      }
    };

    const onDeleted = (payload: unknown) => {
      try {
        const { id } = payload as { id: string };
        addPending(indexName, id, { type: 'delete', attempts: 0, writeTs: nextWriteTs() });
      } catch (err) {
        logger.error('event-sync error processing delete', {
          component: 'slingshot-search.eventSync',
          storageName,
          err: err instanceof Error ? err.message : String(err),
        });
        emitSyncFailed(indexName, entity.name, undefined, err);
      }
    };

    dynamicBus.on(createdEvent, onCreatedOrUpdated);
    dynamicBus.on(updatedEvent, onCreatedOrUpdated);
    dynamicBus.on(deletedEvent, onDeleted);

    unsubscribers.push(
      () => dynamicBus.off(createdEvent, onCreatedOrUpdated),
      () => dynamicBus.off(updatedEvent, onCreatedOrUpdated),
      () => dynamicBus.off(deletedEvent, onDeleted),
    );

    subscribedConfigEntities.add(storageName);
    ensureFlushTimer();
  }

  // -------------------------------------------------------------------------
  // Legacy entity subscriptions
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Public interface
  // -------------------------------------------------------------------------

  const manager: EventSyncManager = {
    subscribeConfigEntity(entity) {
      subscribeConfigEntity(entity);
    },

    subscribeConfigEntities(entities) {
      for (const entity of entities) {
        subscribeConfigEntity(entity);
      }
    },

    async flush() {
      await flushPending();
    },

    async teardown() {
      // Stop the flush timer so no new ticks can be scheduled.
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = undefined;
      }
      flushRequested = false;

      // If a tick was already in flight when teardown was called we need to
      // stop it from writing back to provider state after the teardown
      // returns. We can't await `flushing` directly because doing so would
      // require a settle promise. Instead we set `tornDown` BEFORE the drain
      // so the in-flight flush exits at the next async hop, then run a
      // dedicated teardown drain that bypasses the flag.
      tornDown = true;

      // P-SEARCH-6: explicitly await any timer-driven flush that's still in
      // flight. Without this await, the flush could complete after the
      // pending/indexStates maps have been cleared and write back to the
      // empty maps (or worse, observe a partially-cleared snapshot).
      const carried = inFlightFlush;
      if (carried) {
        try {
          await carried;
        } catch {
          // already logged in the timer/requestFlush catch block
        }
      }

      // Belt-and-braces: even after awaiting the captured promise, ensure the
      // `flushing` lock has been released. Bounded loop avoids spinning if
      // the captured promise didn't cover a follow-up flush.
      for (let i = 0; i < 10 && flushing; i++) {
        await Promise.resolve();
      }

      // Drain any operations that landed in `pending` between subscribe and
      // teardown (or were restored by an aborted in-flight flush). We
      // temporarily clear `tornDown` for the drain pass so the body of
      // `flushPending` can run end-to-end.
      tornDown = false;
      try {
        await flushPending();
      } catch (err) {
        logger.error('event-sync teardown flush error', {
          component: 'slingshot-search.eventSync',
          err: err instanceof Error ? err.message : String(err),
        });
      }
      tornDown = true;

      // Unsubscribe all event listeners
      for (const unsub of unsubscribers) unsub();
      unsubscribers.length = 0;

      // Clear state. Pending/indexStates are cleared synchronously; the DLQ
      // store is only cleared for the in-memory default — durable adapters
      // are not wiped because the DLQ is operator-owned recovery state.
      pending.clear();
      indexStates.clear();
      subscribedConfigEntities.clear();
      if (isInMemoryDlq) {
        defaultDlqStore.clearSync();
        deadLetterCount = 0;
      }
      inFlightFlush = null;
      // Publish the post-teardown gauge so dashboards show 0, not the last
      // pre-teardown peak. Cheap and avoids stale alarms after shutdown.
      metrics.gauge('search.eventSync.dlq.size', isInMemoryDlq ? 0 : deadLetterCount);
    },

    getHealth(): HealthReport {
      const detail = manager.getEventSyncHealth();
      const state =
        detail.deadLetterCount > 0 || detail.lastError !== null ? 'degraded' : 'healthy';
      return {
        component: 'slingshot-search.eventSync',
        state,
        message: detail.lastError ?? undefined,
        details: {
          pendingCount: detail.pendingCount,
          dlqCount: detail.dlqCount,
          deadLetterCount: detail.deadLetterCount,
          flushing: detail.flushing,
          evictedFromDeadLetter: detail.evictedFromDeadLetter,
          droppedFromRateLimit: detail.droppedFromRateLimit,
          lastFlushAt: detail.lastFlushAt,
        },
      };
    },

    getEventSyncHealth(): EventSyncHealth {
      let pendingCount = 0;
      for (const indexMap of pending.values()) pendingCount += indexMap.size;
      // Use the authoritative store size for the in-memory DLQ so the health
      // snapshot reflects the exact state at call time (no TOCTOU gap between
      // a cached counter write and a concurrent health read). For durable stores
      // the cached counter is eventually consistent — operators who need exact
      // counts should query the store directly.
      const effectiveDlqCount = isInMemoryDlq ? defaultDlqStore.size() : deadLetterCount;
      return {
        pendingCount,
        deadLetterCount: effectiveDlqCount,
        dlqCount: effectiveDlqCount,
        flushing,
        evictedFromDeadLetter,
        lastFlushAt,
        lastError,
        droppedFromRateLimit,
      };
    },

    getDeadLetters(): ReadonlyArray<FlushDeadLetterEntry> {
      if (isInMemoryDlq) return defaultDlqStore.snapshotSync();
      // Durable DLQ stores require async access (dlqStore.getAll()). Returning an
      // empty array here is intentional to avoid blocking callers with a sync-only
      // API, but operators should not interpret this as "no dead letters exist."
      // Call dlqStore.getAll() directly for the authoritative list.
      return [];
    },

    async replayDlq(): Promise<{ processed: number; failed: number; total: number }> {
      if (isInMemoryDlq) {
        // In-memory DLQ entries are transient and not recoverable across
        // restarts; there is nothing meaningful to replay from the in-memory
        // store. Return a zero summary.
        return { processed: 0, failed: 0, total: 0 };
      }

      // For file-backed stores, delegate to the store's replayDlq with a
      // handler that re-processes entries through the provider.
      if (fileDlqStore) {
        return fileDlqStore.replayDlq(async entry => {
          const state = indexStates.get(entry.indexName);
          if (!state) return false;
          try {
            if (entry.operation === 'delete') {
              await state.provider.deleteDocuments(entry.indexName, [entry.documentId]);
              return true;
            }
            // For 'index' operations we do not have the full document body
            // in the DLQ entry, so we re-enqueue a delete placeholder + flush
            // to trigger a fresh re-index from the provider. If the document
            // has been deleted from the primary store since it was dead-lettered,
            // the delete will be processed and that is the correct outcome.
            await state.provider.deleteDocuments(entry.indexName, [entry.documentId]);
            return true;
          } catch {
            return false;
          }
        });
      }

      // For generic durable stores (custom DlqStore implementations without
      // replayDlq), read entries and re-process directly.
      try {
        const entries = await dlqStore.getAll();
        let processed = 0;
        let failed = 0;

        for (const entry of entries as FlushDeadLetterEntry[]) {
          const state = indexStates.get(entry.indexName);
          if (!state) {
            failed++;
            continue;
          }
          try {
            if (entry.operation === 'delete') {
              await state.provider.deleteDocuments(entry.indexName, [entry.documentId]);
            } else {
              await state.provider.deleteDocuments(entry.indexName, [entry.documentId]);
            }
            await dlqStore.delete(entry.indexName, entry.documentId);
            processed++;
          } catch {
            failed++;
          }
        }

        return { processed, failed, total: processed + failed };
      } catch {
        return { processed: 0, failed: 0, total: 0 };
      }
    },
  };

  return manager;
}
