import { createHash, randomBytes } from 'node:crypto';
import type { RegistryDocument, RegistryLock, RegistryProvider } from '../types/registry';
import { createEmptyRegistryDocument } from '../types/registry';

/**
 * Configuration for the Redis-backed registry provider.
 */
export interface RedisRegistryConfig {
  /** Redis URL (e.g. `'redis://localhost:6379'` or `'rediss://...'`). */
  url: string;
  /** Redis key for the registry document. Default: `'slingshot:registry'`. */
  key?: string;
}

/**
 * Lazily import the `ioredis` package (optional peer dependency).
 *
 * @returns The `ioredis` module namespace (`typeof import('ioredis')`).
 *
 * @throws {Error} If `ioredis` is not installed in the current project
 *   (`bun add ioredis` to resolve).
 */
async function loadIoredis(): Promise<typeof import('ioredis')> {
  try {
    return await import('ioredis');
  } catch {
    throw new Error('ioredis is not installed. Run: bun add ioredis');
  }
}

/**
 * Compute a SHA-256 hex digest of a string for use as an ETag.
 *
 * @param content - The serialized registry document to hash.
 * @returns A 64-character lowercase hex string (SHA-256 digest).
 *
 * @remarks
 * ETags are compared before writes to detect concurrent modifications. A
 * mismatch means the registry was updated by another writer between the last
 * `read()` and the current `write()`.
 */
function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Create a registry provider that persists the `RegistryDocument` as a JSON
 * string in a Redis key.
 *
 * Optimistic concurrency is provided via SHA-256 ETags: `write()` uses Redis
 * `WATCH` to detect concurrent modifications and re-throws if the current hash
 * does not match the supplied ETag. True distributed locking uses a `SET NX PX`
 * lock key with a configurable TTL; `release()` uses a Lua script to atomically
 * delete the lock only if the lock ID matches.
 *
 * `initialize()` uses `SETNX` to write an empty document only if the key does
 * not already exist.
 *
 * Uses lazy-loaded `ioredis`; the package must be installed as an optional peer
 * dependency.
 *
 * @param config - Redis connection URL and optional key name.
 * @returns A `RegistryProvider` backed by Redis.
 *
 * @throws {Error} If `ioredis` is not installed.
 * @throws {Error} If a concurrent write is detected (ETag mismatch).
 * @throws {Error} If the lock cannot be acquired (another process holds it).
 *
 * @example
 * ```ts
 * import { createRedisRegistry } from '@lastshotlabs/slingshot-infra';
 *
 * const registry = createRedisRegistry({ url: 'redis://localhost:6379' });
 * await registry.initialize();
 * ```
 */
export function createRedisRegistry(config: RedisRegistryConfig): RegistryProvider {
  const registryKey = config.key ?? 'slingshot:registry';

  async function getClient() {
    const { default: Redis } = await loadIoredis();
    return new Redis(config.url);
  }

  return {
    name: 'redis',

    async read(): Promise<RegistryDocument | null> {
      const client = await getClient();
      try {
        const raw = await client.get(registryKey);
        if (!raw) return null;
        return JSON.parse(raw) as RegistryDocument;
      } finally {
        await client.quit();
      }
    },

    async write(doc: RegistryDocument, etag?: string): Promise<{ etag: string }> {
      const client = await getClient();
      try {
        doc.updatedAt = new Date().toISOString();
        const newContent = JSON.stringify(doc, null, 2);
        const newEtag = computeHash(newContent);

        if (etag) {
          // Optimistic locking: WATCH key, verify current hash matches etag, then SET
          await client.watch(registryKey);
          const current = await client.get(registryKey);
          const currentHash = current ? computeHash(current) : '';

          if (currentHash !== etag) {
            await client.unwatch();
            throw new Error(
              '[slingshot-infra] Registry was modified by another process. Re-read and retry.',
            );
          }

          const multi = client.multi();
          multi.set(registryKey, newContent);
          const results = await multi.exec();

          if (!results) {
            throw new Error(
              '[slingshot-infra] Registry was modified by another process. Re-read and retry.',
            );
          }
        } else {
          await client.set(registryKey, newContent);
        }

        return { etag: newEtag };
      } finally {
        await client.quit();
      }
    },

    async initialize(): Promise<void> {
      const client = await getClient();
      try {
        const initial = createEmptyRegistryDocument('');
        const content = JSON.stringify(initial, null, 2);
        // setnx: only set if key does not already exist
        await client.setnx(registryKey, content);
      } finally {
        await client.quit();
      }
    },

    async lock(ttlMs?: number): Promise<RegistryLock> {
      const effectiveTtl = ttlMs ?? 30_000;
      const lockKey = `${registryKey}:lock`;
      const lockId = randomBytes(16).toString('hex');

      const client = await getClient();
      try {
        // SET PX NX — acquire lock only if not already held, with TTL
        const result = await client.set(lockKey, lockId, 'PX', effectiveTtl, 'NX');
        if (!result) {
          throw new Error(
            '[slingshot-infra] Could not acquire registry lock — another process holds it.',
          );
        }

        // Read current doc to get etag
        const raw = await client.get(registryKey);
        const etag = raw ? computeHash(raw) : '';

        return {
          etag,
          async release(): Promise<void> {
            // Lua script: only delete the lock if the value matches our lockId (atomic)
            const lua = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
            await client.eval(lua, 1, lockKey, lockId);
            await client.quit();
          },
        };
      } catch (err) {
        await client.quit();
        throw err;
      }
    },
  };
}
