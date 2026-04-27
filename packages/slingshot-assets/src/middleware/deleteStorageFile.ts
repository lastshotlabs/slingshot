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
}

/**
 * Remove the backing storage object after a successful asset delete.
 *
 * The middleware reads the asset record before delegating so it still has access
 * to the storage key once the entity record is gone.
 *
 * @param deps - Storage and asset adapters used for cleanup.
 * @returns After-middleware that deletes the backing object on successful deletes.
 */
export function createDeleteStorageFileMiddleware(
  deps: DeleteStorageFileMiddlewareDeps,
): MiddlewareHandler {
  const { storage, assetAdapter } = deps;

  return async (c, next) => {
    const id = c.req.param('id');
    const asset = id ? await assetAdapter.getById(id) : null;

    await next();

    if (!asset) return;
    if (c.res.status < 200 || c.res.status >= 300) return;

    try {
      await storage.delete(asset.key);
    } catch (err) {
      console.error(
        `[slingshot-assets] Failed to delete storage object for key "${asset.key}":`,
        err,
      );
    }
  };
}
