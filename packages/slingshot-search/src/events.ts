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
 *
 * Only `search:index.updated` and `search:reindex.completed` are registered
 * as client-safe SSE events (see `SEARCH_CLIENT_SAFE_KEYS`). The remaining
 * events carry document IDs or error details and are kept server-side only.
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
  }
}

/**
 * Search event keys safe to stream to browser clients via SSE.
 *
 * Only non-sensitive events appear here: index metadata updates and reindex
 * completion notifications. Events carrying document content (indexed/deleted)
 * or error details are intentionally excluded.
 *
 * The search plugin registers these automatically in `setupPost` via
 * `bus.registerClientSafeEvents()`. Consumer apps can import the list to
 * subscribe in custom SSE handlers.
 *
 * @example
 * ```ts
 * import { SEARCH_CLIENT_SAFE_KEYS } from '@lastshotlabs/slingshot-search';
 *
 * bus.registerClientSafeEvents([...SEARCH_CLIENT_SAFE_KEYS]);
 * ```
 */
export const SEARCH_CLIENT_SAFE_KEYS = [
  'search:index.updated',
  'search:reindex.completed',
] as const;

/**
 * Union type of search event key names safe to stream to browser clients.
 *
 * @see SEARCH_CLIENT_SAFE_KEYS
 */
export type SearchClientSafeKey = (typeof SEARCH_CLIENT_SAFE_KEYS)[number];
