import type { MiddlewareHandler } from 'hono';
import {
  type Logger,
  type SlingshotEvents,
  type StorageAdapter,
  noopLogger,
} from '@lastshotlabs/slingshot-core';
import type { AssetAdapter, OrphanedKeyRecord } from '../types';

/**
 * Recovery API for orphaned-key reconciliation. Apps can fetch the in-memory
 * orphan list to re-attempt manual cleanup or to expose a dashboard view.
 *
 * The list is bounded — the oldest entries are evicted once `maxRecords` is
 * exceeded — so this is *not* durable storage. Apps that need persistence
 * MUST wire `onOrphanedKey` to push records onto an external queue.
 */
export interface OrphanedKeyRegistry {
  /** Total number of orphans currently retained in memory. */
  size(): number;
  /** Snapshot of all orphans recorded since `since` (or all when omitted). */
  listOrphanedKeys(since?: Date): ReadonlyArray<OrphanedKeyRecord>;
  /** Internal — append a new record (used by the middleware on retry exhaustion). */
  record(record: OrphanedKeyRecord): void;
  /** Reset the registry. Tests / operator-driven manual reconciliation. */
  clear(): void;
}

/**
 * Build a bounded in-memory orphaned-key registry. Default cap is 1 000
 * entries — enough to surface bursts without unbounded memory growth.
 */
export function createOrphanedKeyRegistry(maxRecords = 1000): OrphanedKeyRegistry {
  const records: OrphanedKeyRecord[] = [];

  return {
    size() {
      return records.length;
    },
    listOrphanedKeys(since?: Date) {
      if (!since) return [...records];
      const cutoff = since.getTime();
      return records.filter(r => r.recordedAt >= cutoff);
    },
    record(record) {
      records.push(record);
      while (records.length > maxRecords) records.shift();
    },
    clear() {
      records.length = 0;
    },
  };
}

/**
 * Dependencies for the asset delete storage cleanup middleware.
 */
export interface DeleteStorageFileMiddlewareDeps {
  /** Storage adapter that owns the uploaded bytes. */
  storage: StorageAdapter;
  /** Asset adapter used to look up the storage key before deletion. */
  assetAdapter: AssetAdapter;
  /** Maximum delete-retry attempts (each waits attempt × 250 ms). Default 3. */
  retryAttempts?: number;
  /** Structured logger. Defaults to {@link noopLogger}. */
  logger?: Logger;
  /** Registry-backed event publisher for `asset:storageDeleteFailed`. */
  events?: SlingshotEvents;
  /**
   * Optional callback invoked synchronously after retries are exhausted. Use
   * to record the orphan to an external recovery queue. Throws are caught and
   * logged so the orphan record path is never aborted.
   */
  onOrphanedKey?: (record: OrphanedKeyRecord) => void;
  /** Bounded in-memory orphan registry used by the recovery API. */
  orphanRegistry?: OrphanedKeyRegistry;
}

const DEFAULT_RETRY_ATTEMPTS = 3;

const sleep = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Remove the backing storage object after a successful asset delete.
 *
 * The middleware reads the asset record before delegating so it still has access
 * to the storage key once the entity record is gone. Storage deletion is
 * retried with linear backoff so transient adapter failures (e.g. a flaky S3
 * gateway) do not silently orphan files. After all retries are exhausted the
 * key is:
 *  1. Logged via `Logger.error` with structured fields;
 *  2. Emitted as an `asset:storageDeleteFailed` event (when an `events`
 *     publisher is wired);
 *  3. Pushed through the optional `onOrphanedKey` callback for app-level
 *     recovery queues; and
 *  4. Recorded in the bounded `orphanRegistry` so `listOrphanedKeys()` can
 *     return it.
 *
 * @param deps - Storage and asset adapters used for cleanup.
 * @returns After-middleware that deletes the backing object on successful deletes.
 */
export function createDeleteStorageFileMiddleware(
  deps: DeleteStorageFileMiddlewareDeps,
): MiddlewareHandler {
  const {
    storage,
    assetAdapter,
    retryAttempts = DEFAULT_RETRY_ATTEMPTS,
    logger = noopLogger,
    events,
    onOrphanedKey,
    orphanRegistry,
  } = deps;

  return async (c, next) => {
    const id = c.req.param('id');
    const asset = id ? await assetAdapter.getById(id) : null;

    await next();

    if (!asset) return;
    if (c.res.status < 200 || c.res.status >= 300) return;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= retryAttempts; attempt++) {
      try {
        await storage.delete(asset.key);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < retryAttempts) {
          await sleep(attempt * 250);
        }
      }
    }

    const lastErrorMessage = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const record: OrphanedKeyRecord = {
      key: asset.key,
      assetId: asset.id ?? null,
      tenantId: asset.tenantId ?? null,
      retries: retryAttempts,
      lastError: lastErrorMessage,
      recordedAt: Date.now(),
    };

    logger.error('asset storage delete exhausted retries', {
      component: 'slingshot-assets.deleteStorageFile',
      key: record.key,
      assetId: record.assetId,
      tenantId: record.tenantId,
      retries: record.retries,
      lastError: record.lastError,
    });

    if (events) {
      try {
        events.publish(
          'asset:storageDeleteFailed',
          {
            key: record.key,
            assetId: record.assetId,
            tenantId: record.tenantId,
            retries: record.retries,
            lastError: record.lastError,
          },
          { source: 'system', requestTenantId: record.tenantId },
        );
      } catch (publishErr) {
        logger.error('asset:storageDeleteFailed event publish failed', {
          component: 'slingshot-assets.deleteStorageFile',
          err: publishErr instanceof Error ? publishErr.message : String(publishErr),
        });
      }
    }

    if (orphanRegistry) {
      try {
        orphanRegistry.record(record);
      } catch (regErr) {
        logger.error('orphan registry record failed', {
          component: 'slingshot-assets.deleteStorageFile',
          err: regErr instanceof Error ? regErr.message : String(regErr),
        });
      }
    }

    if (onOrphanedKey) {
      try {
        onOrphanedKey(record);
      } catch (cbErr) {
        logger.error('onOrphanedKey callback failed', {
          component: 'slingshot-assets.deleteStorageFile',
          err: cbErr instanceof Error ? cbErr.message : String(cbErr),
        });
      }
    }
  };
}
