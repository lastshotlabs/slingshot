import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
import { DEFAULT_MAX_ENTRIES, evictOldest } from '@lastshotlabs/slingshot-core';

/**
 * Create a `StorageAdapter` that stores files in-process in a `Map`.
 *
 * @remarks
 * **Ephemeral, in-process only** — all stored data lives in heap memory and is
 * discarded when the process exits or the adapter is garbage-collected.  This
 * adapter is suitable for development, testing, and single-process environments
 * only.  It must **not** be used in production multi-process deployments because
 * files stored in one process are invisible to other processes.
 *
 * Entries are evicted via LRU when the store reaches `DEFAULT_MAX_ENTRIES`
 * (imported from `slingshot-core`) to prevent unbounded memory growth.
 *
 * @returns A `StorageAdapter` backed by an in-process `Map`.
 */
export const memoryStorage = (): StorageAdapter => {
  const store = new Map<string, { data: Buffer; mimeType: string; size: number }>();

  return {
    async put(key, data, meta) {
      let buf: Buffer;
      if (data instanceof Blob) {
        buf = Buffer.from(await data.arrayBuffer());
      } else if (data instanceof ReadableStream) {
        const chunks: Uint8Array[] = [];
        const reader = (data as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        buf = Buffer.concat(chunks);
      } else {
        buf = data;
      }
      evictOldest(store, DEFAULT_MAX_ENTRIES);
      store.set(key, { data: buf, mimeType: meta.mimeType, size: meta.size });
      return {};
    },
    get(key) {
      const entry = store.get(key);
      if (!entry) return Promise.resolve(null);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(entry.data);
          controller.close();
        },
      });
      return Promise.resolve({ stream, mimeType: entry.mimeType, size: entry.size });
    },
    delete(key) {
      store.delete(key);
      return Promise.resolve();
    },
  };
};
