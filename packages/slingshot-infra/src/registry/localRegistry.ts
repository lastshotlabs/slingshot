import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RegistryDocument, RegistryLock, RegistryProvider } from '../types/registry';
import { createEmptyRegistryDocument } from '../types/registry';

/**
 * Configuration for the local filesystem registry provider.
 */
export interface LocalRegistryConfig {
  /** Absolute or relative path to the JSON registry file. */
  path: string;
}

/**
 * Create a registry provider that persists the `RegistryDocument` as a JSON
 * file on the local filesystem.
 *
 * Optimistic concurrency is provided via MD5 ETags: `write()` checks the
 * current file hash against the supplied etag before overwriting. Parent
 * directories are created automatically on first write.
 *
 * Intended for local development and single-machine CI pipelines. For
 * team environments use `createS3Registry()` or `createPostgresRegistry()`.
 *
 * @param config - Filesystem path to the registry JSON file.
 * @returns A `RegistryProvider` backed by a local file.
 *
 * @throws {Error} If a concurrent write is detected (etag mismatch).
 *
 * @example
 * ```ts
 * import { createLocalRegistry } from '@lastshotlabs/slingshot-infra';
 *
 * const registry = createLocalRegistry({ path: '.slingshot/registry.json' });
 * await registry.initialize();
 * ```
 */
export function createLocalRegistry(config: LocalRegistryConfig): RegistryProvider {
  const filePath = config.path;
  let cachedEtag: string | undefined;

  function parseRegistryDocument(content: string): RegistryDocument {
    return JSON.parse(content) as RegistryDocument;
  }

  function computeEtag(content: string): string {
    return createHash('md5').update(content).digest('hex');
  }

  return {
    name: 'local',

    read(): Promise<RegistryDocument | null> {
      if (!existsSync(filePath)) return Promise.resolve(null);
      const content = readFileSync(filePath, 'utf-8');
      cachedEtag = computeEtag(content);
      return Promise.resolve(parseRegistryDocument(content));
    },

    write(doc: RegistryDocument, etag?: string): Promise<{ etag: string }> {
      if (etag && existsSync(filePath)) {
        const currentContent = readFileSync(filePath, 'utf-8');
        const currentEtag = computeEtag(currentContent);
        if (currentEtag !== etag) {
          return Promise.reject(
            new Error(
              '[slingshot-infra] Registry was modified by another process. ' + 'Re-read and retry.',
            ),
          );
        }
      }

      doc.updatedAt = new Date().toISOString();
      const content = JSON.stringify(doc, null, 2);
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(filePath, content, 'utf-8');
      cachedEtag = computeEtag(content);
      return Promise.resolve({ etag: cachedEtag });
    },

    async initialize(): Promise<void> {
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      if (!existsSync(filePath)) {
        const initial = createEmptyRegistryDocument('');
        await this.write(initial);
      }
    },

    async lock(): Promise<RegistryLock> {
      if (!cachedEtag) {
        await this.read();
      }
      const etag = cachedEtag ?? '';
      return {
        etag,
        async release() {
          // No-op for local registry
        },
      };
    },
  };
}
