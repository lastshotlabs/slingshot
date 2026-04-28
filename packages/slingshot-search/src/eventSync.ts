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
import type {
  GeoSearchConfig,
  ResolvedEntityConfig,
  SlingshotEventBus,
  SlingshotEvents,
} from '@lastshotlabs/slingshot-core';
import { applyGeoTransform } from './geoTransform';
import type { SearchManager } from './searchManager';
import type { SearchTransformRegistry } from './transformRegistry';
import type { SearchPluginConfig } from './types/config';
import type { SearchProvider } from './types/provider';

/**
 * Narrow bus type for dynamic entity event keys (e.g. `entity:users.created`).
 * The core SlingshotEventBus only accepts typed event map keys; entity CRUD events
 * are dynamic strings built at runtime from storage names. This cast target keeps
 * the type escape localized to eventSync rather than widening the global interface.
 */
interface DynamicEventBus {
  emit(event: string, payload: unknown): void;
  on(event: string, listener: (payload: unknown) => void | Promise<void>): void;
  off(event: string, listener: (payload: unknown) => void | Promise<void>): void;
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
  readonly onFlushDeadLetter?: (entry: FlushDeadLetterEntry) => void;
}

/** Public interface for an event-bus sync manager instance. */
export interface EventSyncManager {
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
   * Includes the current pending queue size, dead-letter map size, and whether
   * a flush is in progress. Safe to call concurrently with subscriptions and
   * flushes.
   */
  getHealth(): EventSyncHealth;

  /**
   * Snapshot of the dead-letter map. Returns a frozen array of entries — the
   * underlying map is not exposed by reference so callers can safely iterate
   * without observing concurrent mutations.
   */
  getDeadLetters(): ReadonlyArray<FlushDeadLetterEntry>;
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

/** Health snapshot exposed via `EventSyncManager.getHealth()`. */
export interface EventSyncHealth {
  /** Number of operations currently waiting in the pending queue (across all indexes). */
  readonly pendingCount: number;
  /** Number of operations currently in the dead-letter map. */
  readonly deadLetterCount: number;
  /** Whether a flush is currently in progress. */
  readonly flushing: boolean;
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
  } = config;

  // Closure-owned state
  const unsubscribers: Array<() => void> = [];
  const pending = new Map<string, Map<string, PendingAction>>();
  const indexStates = new Map<string, IndexSyncState>();
  const subscribedConfigEntities = new Set<string>();
  // (indexName -> docId -> entry) dead-letter map for ops that exceeded
  // `maxFlushAttempts`. Kept in memory so operators can inspect via getHealth /
  // getDeadLetters; persistent DLQ storage is an `onFlushDeadLetter` concern.
  const deadLetters = new Map<string, Map<string, FlushDeadLetterEntry>>();
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let flushing = false;
  let flushRequested = false;
  let tornDown = false;
  // Monotonic counter — never resets, never reused — used to mark per-doc
  // write timestamps so restore-pending can detect newer-vs-older ops.
  let writeTsCounter = 0;
  function nextWriteTs(): number {
    writeTsCounter += 1;
    return writeTsCounter;
  }

  // Entity CRUD events use dynamic string keys (e.g., 'entity:users.created').
  // Cast to DynamicEventBus for dynamic subscriptions; typed bus for known events.
  const dynamicBus = bus as unknown as DynamicEventBus;

  // -------------------------------------------------------------------------
  // Pending queue management
  // -------------------------------------------------------------------------

  function ensureFlushTimer(): void {
    if (flushTimer || tornDown) return;
    flushTimer = setInterval(() => {
      flushPending().catch((err: unknown) => {
        console.error('[slingshot-search:event-sync] Flush error:', err);
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

  function requestFlush(errorPrefix: string): void {
    if (flushing) {
      flushRequested = true;
      return;
    }
    flushPending().catch((err: unknown) => {
      console.error(errorPrefix, err);
    });
  }

  async function flushPending(): Promise<void> {
    // Guard against concurrent flushes
    if (flushing) return;
    flushing = true;
    flushRequested = false;

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
          console.error(
            `[slingshot-search:event-sync] No sync state for index '${indexName}'. Dropping operations.`,
          );
          continue;
        }

        const toIndex: Array<Record<string, unknown>> = [];
        const toDelete: string[] = [];

        for (const [docId, action] of actions) {
          if (action.type === 'index') {
            toIndex.push(action.document);
          } else {
            toDelete.push(docId);
          }
        }

        // Process deletions
        if (toDelete.length > 0) {
          try {
            await state.provider.deleteDocuments(indexName, toDelete);
          } catch (err) {
            console.error(
              `[slingshot-search:event-sync] Failed to delete ${toDelete.length} documents from '${indexName}':`,
              err,
            );
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

        // Process indexes
        if (toIndex.length > 0) {
          try {
            await state.provider.indexDocuments(indexName, toIndex, state.pkField);
          } catch (err) {
            console.error(
              `[slingshot-search:event-sync] Failed to index ${toIndex.length} documents to '${indexName}':`,
              err,
            );
            // Same invariant as the delete branch above — compare per-doc
            // `writeTs` to avoid clobbering a newer pending op with this
            // older snapshot one, and DLQ on retry-budget exhaustion.
            let indexPending = pending.get(indexName);
            if (!indexPending) {
              indexPending = new Map();
              pending.set(indexName, indexPending);
            }
            for (const [docId, action] of actions) {
              if (action.type !== 'index') continue;
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
      if (flushRequested && pending.size > 0 && !tornDown) {
        flushRequested = false;
        void flushPending().catch((err: unknown) => {
          console.error('[slingshot-search:event-sync] Follow-up flush error:', err);
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
    events.publish(
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
    console.error(
      `[slingshot-search:event-sync] DLQ: ${operation} for ${indexName}/${documentId} ` +
        `exhausted after ${attempts} attempts:`,
      err,
    );
    if (!events) return;
    events.publish(
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

  /**
   * Move an op past the retry budget into the in-memory dead-letter map and
   * fire the structured `search:sync.dead` event plus the optional
   * `onFlushDeadLetter` callback. Any exceptions raised by the callback are
   * caught and logged so DLQ promotion is never aborted.
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
    let perIndex = deadLetters.get(indexName);
    if (!perIndex) {
      perIndex = new Map();
      deadLetters.set(indexName, perIndex);
    }
    perIndex.set(documentId, entry);

    emitSyncDead(indexName, entityName, documentId, operation, err, attempts);

    if (onFlushDeadLetter) {
      try {
        onFlushDeadLetter(entry);
      } catch (cbErr) {
        console.error('[slingshot-search:event-sync] onFlushDeadLetter callback error:', cbErr);
      }
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
          transformed = applyGeoTransform(transformed, geoConfig);
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
        console.error(
          `[slingshot-search:event-sync] Error processing create/update for ${storageName}:`,
          err,
        );
        emitSyncFailed(indexName, entity.name, undefined, err);
      }
    };

    const onDeleted = (payload: unknown) => {
      try {
        const { id } = payload as { id: string };
        addPending(indexName, id, { type: 'delete', attempts: 0, writeTs: nextWriteTs() });
      } catch (err) {
        console.error(
          `[slingshot-search:event-sync] Error processing delete for ${storageName}:`,
          err,
        );
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
      tornDown = true;
      flushRequested = false;

      // Clear the flush timer
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = undefined;
      }

      // Flush remaining pending operations
      await flushPending();

      // Unsubscribe all event listeners
      for (const unsub of unsubscribers) unsub();
      unsubscribers.length = 0;

      // Clear state
      pending.clear();
      indexStates.clear();
      subscribedConfigEntities.clear();
      deadLetters.clear();
    },

    getHealth(): EventSyncHealth {
      let pendingCount = 0;
      for (const indexMap of pending.values()) pendingCount += indexMap.size;
      let deadLetterCount = 0;
      for (const indexMap of deadLetters.values()) deadLetterCount += indexMap.size;
      return { pendingCount, deadLetterCount, flushing };
    },

    getDeadLetters(): ReadonlyArray<FlushDeadLetterEntry> {
      const out: FlushDeadLetterEntry[] = [];
      for (const indexMap of deadLetters.values()) {
        for (const entry of indexMap.values()) out.push(entry);
      }
      return out;
    },
  };

  return manager;
}
