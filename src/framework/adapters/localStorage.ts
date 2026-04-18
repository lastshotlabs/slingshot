import { unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { RuntimeFs, StorageAdapter } from '@lastshotlabs/slingshot-core';
import { HttpError } from '@lastshotlabs/slingshot-core';

/** Default RuntimeFs implementation using Bun's native file APIs. */
const defaultFs: RuntimeFs = {
  async write(path: string, data: string | Uint8Array): Promise<void> {
    await Bun.write(path, data);
  },
  async readFile(path: string): Promise<Uint8Array | null> {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return new Uint8Array(await file.arrayBuffer());
  },
  async exists(path: string): Promise<boolean> {
    return Bun.file(path).exists();
  },
};

export interface LocalStorageConfig {
  directory: string;
  baseUrl?: string;
  /** Runtime filesystem abstraction. Defaults to Bun's native file APIs. */
  fs?: RuntimeFs;
}

/**
 * Resolve a storage key to an absolute filesystem path under `directory`.
 *
 * @remarks
 * **Path traversal protection** — this function rejects any key that would
 * escape the configured `directory`:
 * - Empty or whitespace-only keys are rejected.
 * - Absolute paths (Unix `/foo`, Windows `C:\foo`, UNC `//server`) are rejected.
 * - After resolution via `path.resolve()`, the resulting path must start with
 *   `directory + sep` (or equal `directory`); any path that resolves outside is
 *   rejected.
 *
 * All rejections throw `HttpError(400)` so callers receive a well-formed
 * error response rather than an unhandled exception.
 *
 * @param directory - The absolute root directory that all stored files must
 *   reside within.
 * @param key - The storage key provided by the caller (relative path segments
 *   such as `"users/avatar.jpg"` are valid).
 * @returns The absolute filesystem path for the key.
 * @throws {HttpError} `400 Invalid storage key` when the key is empty, absolute,
 *   or would resolve outside `directory`.
 */
function resolveKey(directory: string, key: string): string {
  if (!key || !key.trim()) throw new HttpError(400, 'Invalid storage key');
  const normalized = key.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')) {
    throw new HttpError(400, 'Invalid storage key');
  }
  const root = resolve(directory);
  const candidate = resolve(root, normalized);
  if (candidate === root || !candidate.startsWith(root + sep)) {
    throw new HttpError(400, 'Invalid storage key');
  }
  return candidate;
}

/**
 * Create a `StorageAdapter` that persists files in the local filesystem.
 *
 * All keys are resolved relative to `config.directory`.  Parent directories
 * are created automatically on `put`.  `get` returns `null` for missing files
 * rather than throwing.  `delete` silently ignores missing files.
 *
 * @remarks
 * **Path traversal protection** — all keys are validated by {@link resolveKey}
 * before any filesystem operation.  Keys that are empty, absolute, or that
 * resolve to a path outside `config.directory` result in a `400 HttpError`,
 * not a filesystem access.
 *
 * @param config - Storage configuration.
 * @param config.directory - Absolute path to the root directory for stored
 *   files.  All put/get/delete operations are constrained to this directory.
 * @param config.baseUrl - Optional public base URL.  When provided, `put`
 *   returns `{ url: "<baseUrl>/<key>" }` so callers can serve files over HTTP.
 * @param config.fs - Optional `RuntimeFs` implementation.  Defaults to Bun's
 *   native file APIs (`Bun.write`, `Bun.file`).  Override for testing.
 * @returns A `StorageAdapter` backed by the local filesystem.
 * @throws {HttpError} `400 Invalid storage key` when `put`, `get`, or `delete`
 *   are called with an invalid key (see {@link resolveKey}).
 *
 * @example
 * ```ts
 * const storage = localStorage({
 *   directory: '/var/uploads',
 *   baseUrl: 'https://cdn.example.com',
 * });
 * await storage.put('images/photo.jpg', buffer, { mimeType: 'image/jpeg', size: buffer.byteLength });
 * ```
 */
export const localStorage = (config: LocalStorageConfig): StorageAdapter => {
  const fs = config.fs ?? defaultFs;
  return {
    async put(key, data) {
      const filePath = resolveKey(config.directory, key);
      // Ensure parent directory exists
      const dir = dirname(filePath);
      if (dir) {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(dir, { recursive: true });
      }
      if (data instanceof Blob) {
        const buf = await data.arrayBuffer();
        await fs.write(filePath, new Uint8Array(buf));
      } else if (data instanceof ReadableStream) {
        const response = new Response(data);
        const buf = await response.arrayBuffer();
        await fs.write(filePath, new Uint8Array(buf));
      } else {
        const bytes =
          data instanceof Uint8Array
            ? data
            : new Uint8Array((data as Buffer).buffer as ArrayBuffer);
        await fs.write(filePath, bytes);
      }
      const url = config.baseUrl ? `${config.baseUrl.replace(/\/$/, '')}/${key}` : undefined;
      return { ...(url !== undefined ? { url } : {}) };
    },
    async get(key) {
      const filePath = resolveKey(config.directory, key);
      const bytes = await fs.readFile(filePath);
      if (bytes === null) return null;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      return { stream, size: bytes.byteLength };
    },
    async delete(key) {
      const filePath = resolveKey(config.directory, key);
      try {
        await unlink(filePath);
      } catch {
        // File doesn't exist — ignore
      }
    },
  };
};
