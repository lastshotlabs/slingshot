// ---------------------------------------------------------------------------
// Upload Registry — thin wrappers that consume repositories from context
// ---------------------------------------------------------------------------
import { resolveContext } from '@lastshotlabs/slingshot-core';
import type { UploadRecord } from '@lastshotlabs/slingshot-core';

export type { UploadRecord };

/**
 * Store a new upload record. Keyed by the storage key.
 *
 * @param record - The upload record to store
 * @param app - The Hono app instance (required — used to resolve the context)
 */
export const registerUpload = async (record: UploadRecord, app: object): Promise<void> => {
  const ctx = resolveContext(app);
  await ctx.persistence.uploadRegistry.register(record);
};

/**
 * Retrieve an upload record by key. Returns null if not found.
 *
 * @param key - The storage key
 * @param app - The Hono app instance (required — used to resolve the context)
 */
export const getUploadRecord = async (key: string, app: object): Promise<UploadRecord | null> => {
  const ctx = resolveContext(app);
  return ctx.persistence.uploadRegistry.get(key);
};

/**
 * Delete an upload record by key. Returns true if it existed.
 *
 * @param key - The storage key
 * @param app - The Hono app instance (required — used to resolve the context)
 */
export const deleteUploadRecord = async (key: string, app: object): Promise<boolean> => {
  const ctx = resolveContext(app);
  return ctx.persistence.uploadRegistry.delete(key);
};
