import { unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { RuntimeFs, StorageAdapter } from '@lastshotlabs/slingshot-core';
import { HttpError } from '@lastshotlabs/slingshot-core';

/** Default RuntimeFs implementation using Bun's file APIs. */
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

/**
 * Configuration for the local filesystem storage adapter.
 */
export interface LocalStorageConfig {
  /** Root directory that stores all uploaded files. */
  readonly directory: string;
  /** Optional public base URL used to build `put()` results. */
  readonly baseUrl?: string;
  /** Runtime filesystem abstraction, mainly for tests. */
  readonly fs?: RuntimeFs;
}

/**
 * Resolve a storage key to an absolute filesystem path under `directory`.
 *
 * Rejects empty keys, absolute paths, and any path that would escape the configured root.
 *
 * @param directory - Root directory for stored files.
 * @param key - Relative storage key.
 * @returns Absolute filesystem path for the key.
 */
function resolveKey(directory: string, key: string): string {
  if (!key || !key.trim()) throw new HttpError(400, 'Invalid storage key');

  // Reject NUL bytes — some Node fs APIs misbehave on these (truncation,
  // bypass of suffix checks, etc.). Belt-and-braces alongside the
  // base-directory containment check below.
  if (key.includes('\0')) throw new HttpError(400, 'Invalid storage key');

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
 * Create a `StorageAdapter` backed by the local filesystem.
 *
 * @param config - Local storage configuration.
 * @returns A storage adapter that reads and writes under `config.directory`.
 */
export function localStorage(config: LocalStorageConfig): StorageAdapter {
  const fs = config.fs ?? defaultFs;

  return {
    async put(key, data) {
      const filePath = resolveKey(config.directory, key);
      const directoryPath = dirname(filePath);

      if (directoryPath) {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(directoryPath, { recursive: true });
      }

      if (data instanceof Blob) {
        const buffer = await data.arrayBuffer();
        await fs.write(filePath, new Uint8Array(buffer));
      } else if (data instanceof ReadableStream) {
        const response = new Response(data);
        const buffer = await response.arrayBuffer();
        await fs.write(filePath, new Uint8Array(buffer));
      } else {
        await fs.write(filePath, data);
      }

      const url = config.baseUrl ? `${config.baseUrl.replace(/\/$/, '')}/${key}` : undefined;
      return url === undefined ? {} : { url };
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
        // Missing files are a safe no-op.
      }
    },
  };
}
