import type { MiddlewareHandler } from 'hono';
import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
import type { AssetAdapter } from '../types';

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
 * key is logged with severity `error` for ops alerting.
 *
 * @param deps - Storage and asset adapters used for cleanup.
 * @returns After-middleware that deletes the backing object on successful deletes.
 */
export function createDeleteStorageFileMiddleware(
  deps: DeleteStorageFileMiddlewareDeps,
): MiddlewareHandler {
  const { storage, assetAdapter, retryAttempts = DEFAULT_RETRY_ATTEMPTS } = deps;

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

    console.error(
      `[slingshot-assets] ORPHANED storage object: failed to delete key "${asset.key}" ` +
        `after ${retryAttempts} attempts. Reconcile manually.`,
      lastErr,
    );
  };
}
