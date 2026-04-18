/**
 * Minimal search provider contract for write-through document sync.
 *
 * This is the minimal contract shared with `slingshot-search` providers.
 * The full-featured interface (search, suggest, index management, reindex)
 * lives in `slingshot-search`. Core only declares the write-side contract so
 * the framework can sync documents without depending on the full search package.
 *
 * @remarks
 * Kept intentionally minimal — `slingshot-core` stays lean for apps that don't use search.
 * Search plugin providers implement both this interface and the extended interface in
 * `slingshot-search`.
 *
 * @example
 * ```ts
 * import type { SearchProviderContract } from '@lastshotlabs/slingshot-core';
 *
 * // In slingshot-data write-through sync:
 * await searchProvider.indexDocument('chat_messages', { id, content }, id);
 * ```
 */
export interface SearchProviderContract {
  /**
   * Index (upsert) a document in the specified index.
   * @param indexName - The index to write to (typically the entity's `_storageName`).
   * @param document - The document to index (key-value record).
   * @param documentId - The unique document identifier for upsert semantics.
   */
  indexDocument(
    indexName: string,
    document: Record<string, unknown>,
    documentId: string,
  ): Promise<void>;
  /**
   * Remove a document from the specified index.
   * @param indexName - The index to delete from.
   * @param documentId - The document identifier to remove.
   */
  deleteDocument(indexName: string, documentId: string): Promise<void>;
}
