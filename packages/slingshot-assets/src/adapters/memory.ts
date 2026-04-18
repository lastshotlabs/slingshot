import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
import { DEFAULT_MAX_ENTRIES, evictOldest } from '@lastshotlabs/slingshot-core';

/**
 * Create a `StorageAdapter` that stores files in-process in memory.
 *
 * Suitable for development and tests only.
 *
 * @returns A fresh in-memory storage adapter.
 */
export function memoryStorage(): StorageAdapter {
  const store = new Map<string, { data: Buffer; mimeType: string; size: number }>();

  return {
    async put(key, data, meta) {
      let buffer: Buffer;

      if (data instanceof Blob) {
        buffer = Buffer.from(await data.arrayBuffer());
      } else if (data instanceof ReadableStream) {
        const chunks: Uint8Array[] = [];
        const reader = (data as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        buffer = Buffer.concat(chunks);
      } else {
        buffer = data;
      }

      evictOldest(store, DEFAULT_MAX_ENTRIES);
      store.set(key, { data: buffer, mimeType: meta.mimeType, size: meta.size });
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
}
