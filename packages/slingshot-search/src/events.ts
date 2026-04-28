/**
 * Search domain events — module augmentation for `SlingshotEventMap`.
 *
 * Extends the core `SlingshotEventMap` interface with all events emitted by the
 * search plugin. This file must be imported (directly or transitively) for
 * the augmented types to be in scope. `slingshot-search/src/index.ts` imports
 * it as a side effect so any consumer that imports from `slingshot-search` gets
 * the types automatically.
 *
 * **Event summary:**
 * | Event key | When emitted |
 * |---|---|
 * | `search:document.indexed` | After a document is successfully indexed |
 * | `search:document.deleted` | After a document is removed from the index |
 * | `search:index.updated` | After an index is created or its settings updated |
 * | `search:index.deleted` | After an index is deleted |
 * | `search:reindex.completed` | After a full reindex operation finishes |
 * | `search:sync.failed` | After a sync operation fails (event-bus or write-through) |
 * | `search:sync.dead` | After event-bus sync exhausts its retry budget |
 * | `search:dlq.evicted` | After a dead-letter entry is evicted from the bounded in-memory DLQ |
 * | `search:geoTransform.skipped` | After a geo transform is skipped because the document lacks expected fields |
 *
 * `search:index.updated` and `search:reindex.completed` are the intended
 * external-facing events when a consumer registers definitions with
 * `exposure: ['client-safe']`. The remaining events carry document IDs or
 * error details and are kept server-side only.
 */

declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    /** Emitted after a document is indexed (write-through or event-bus sync). */
    'search:document.indexed': {
      indexName: string;
      documentId: string;
      entityName: string;
      syncMode: 'write-through' | 'event-bus' | 'manual';
    };

    /** Emitted after a document is removed from the search index. */
    'search:document.deleted': {
      indexName: string;
      documentId: string;
      entityName: string;
    };

    /** Emitted when a search index is created or settings are updated. */
    'search:index.updated': {
      indexName: string;
      entityName: string;
    };

    /** Emitted when a search index is deleted. */
    'search:index.deleted': {
      indexName: string;
    };

    /** Emitted when a full reindex completes for an entity. */
    'search:reindex.completed': {
      indexName: string;
      entityName: string;
      documentCount: number;
      durationMs: number;
    };

    /** Emitted when a search sync fails (write-through or event-bus). */
    'search:sync.failed': {
      indexName: string;
      documentId?: string;
      entityName: string;
      error: string;
      syncMode: 'write-through' | 'event-bus';
    };

    /** Emitted when event-bus search sync exhausts its retry budget. */
    'search:sync.dead': {
      indexName: string;
      documentId: string;
      entityName: string;
      operation: 'index' | 'delete';
      attempts: number;
      error: string;
      syncMode: 'event-bus';
    };

    /**
     * Emitted when a dead-letter entry is evicted because the bounded in-memory
     * DLQ exceeded `maxDeadLetterEntries`. The eviction is permanent unless the
     * caller has wired a durable `dlqStore` to persist entries.
     */
    'search:dlq.evicted': {
      indexName: string;
      documentId: string;
      entityName: string;
      operation: 'index' | 'delete';
      attempts: number;
      error: string;
      reason: 'capacity';
    };

    /**
     * Emitted when geo transform is skipped because the user transform omitted
     * the configured `latField` / `lngField` (or either value is null).
     */
    'search:geoTransform.skipped': {
      indexName: string;
      entityName: string;
      documentId: string;
      latField: string;
      lngField: string;
      reason: 'missingLat' | 'missingLng' | 'missingBoth';
    };
  }
}

export {};
