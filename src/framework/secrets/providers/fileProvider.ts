/**
 * File-based secret repository.
 *
 * Reads secrets from individual files in a directory. Each file name is the
 * secret key, file content is the secret value (trailing newline trimmed).
 *
 * Use cases:
 * - Docker Swarm secrets mounted at /run/secrets/
 * - Kubernetes mounted secret volumes
 * - Any file-based secret injection
 *
 * Factory pattern: closure-owned cache + directory ref, no module-level state.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecretRepository } from '@lastshotlabs/slingshot-core';

export interface FileProviderOptions {
  /** Directory containing secret files (e.g., '/run/secrets') */
  directory: string;
  /** File extension to strip when deriving key names. Default: none. */
  extension?: string;
}

/**
 * Create a `SecretRepository` that reads secrets from files on disk.
 *
 * Each file in `directory` maps to a secret: the file name (minus any
 * configured `extension`) is the key; the trimmed file contents are the value.
 * Trailing newlines are stripped from every value on read.
 *
 * Two read modes are supported:
 * - **Lazy** (before `initialize()` is called): each `get()` / `getMany()`
 *   reads directly from disk on demand.
 * - **Bulk** (after `initialize()` is called): all secrets are read into a
 *   closure-owned `cache` Map. Subsequent `get()` / `getMany()` calls return
 *   cached values without touching the filesystem.
 *
 * @param opts - Configuration options.
 * @param opts.directory - Absolute path to the directory containing secret
 *   files (e.g. `'/run/secrets'`).
 * @param opts.extension - Optional file extension to strip when deriving key
 *   names (e.g. `'.txt'` maps `JWT_SECRET.txt` → `'JWT_SECRET'`).
 * @returns A `SecretRepository` named `'file'` with `initialize()`,
 *   `refresh()`, and `destroy()` lifecycle methods.
 * @throws `Error` with a descriptive message if `initialize()` is called and
 *   `directory` does not exist (`ENOENT`). Other filesystem errors are
 *   re-thrown as-is.
 */
export function createFileSecretRepository(opts: FileProviderOptions): SecretRepository {
  const { directory, extension } = opts;

  // Closure-owned cache — populated on initialize(), keyed by secret name
  const cache = new Map<string, string>();
  let initialized = false;

  /**
   * Strip the configured extension from a filename to derive the secret key.
   *
   * @param filename - The raw filename from the directory listing.
   * @returns The filename without the trailing extension, or the filename
   *   unchanged if it does not end with the configured extension.
   */
  function stripExtension(filename: string): string {
    if (extension && filename.endsWith(extension)) {
      return filename.slice(0, -extension.length);
    }
    return filename;
  }

  /**
   * Read a single secret from disk by key, constructing the filename from the
   * key and the configured extension.
   *
   * @param key - The logical secret key (e.g. `'JWT_SECRET'`).
   * @returns The file contents with the trailing newline stripped, or `null`
   *   if the file does not exist (`ENOENT`).
   * @throws Any filesystem error other than `ENOENT`.
   */
  async function readSecret(key: string): Promise<string | null> {
    const filename = extension ? key + extension : key;
    try {
      const content = await readFile(join(directory, filename), 'utf-8');
      return content.replace(/\n$/, '');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  return {
    name: 'file',

    async initialize() {
      try {
        const files = await readdir(directory);
        for (const file of files) {
          const key = stripExtension(file);
          const content = await readFile(join(directory, file), 'utf-8');
          cache.set(key, content.replace(/\n$/, ''));
        }
        initialized = true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`[secrets/file] Directory not found: ${directory}`, { cause: err });
        }
        throw err;
      }
    },

    async get(key) {
      if (initialized) return cache.get(key) ?? null;
      return readSecret(key);
    },

    async getMany(keys) {
      const result = new Map<string, string>();
      for (const key of keys) {
        const value = initialized ? (cache.get(key) ?? null) : await readSecret(key);
        if (value !== null) result.set(key, value);
      }
      return result;
    },

    async refresh() {
      cache.clear();
      initialized = false;
      await this.initialize?.();
    },

    destroy() {
      cache.clear();
      initialized = false;
      return Promise.resolve();
    },
  };
}
