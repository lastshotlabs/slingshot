/**
 * Asset domain events — module augmentation for `SlingshotEventMap`.
 *
 * The assets plugin emits operational events directly (in addition to the
 * entity-lifecycle events declared on the `Asset` entity). These events are
 * server-side only and used for ops alerting / orphan reconciliation.
 *
 * **Event summary:**
 * | Event key | When emitted |
 * |---|---|
 * | `asset:storageDeleteFailed` | After all retry attempts to delete a backing storage object are exhausted |
 */

declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    /**
     * Emitted when the delete-cascade middleware exhausts its retry budget on
     * the underlying storage adapter. Callers should treat the storage object
     * as orphaned and reconcile via the recovery queue / `listOrphanedKeys`.
     */
    'asset:storageDeleteFailed': {
      key: string;
      assetId: string | null;
      tenantId: string | null;
      retries: number;
      lastError: string;
    };
  }
}

export {};
