/**
 * The RESPONSE cache — a different thing from the PROMPT cache.
 *
 *   prompt cache   → the provider stores your prefix; you still make the call
 *                    and still get fresh output. Saves money.
 *   response cache → we don't make the call at all; you get the SAME answer as
 *                    last time. Saves money AND removes variety.
 *
 * Conflating the two is the expensive mistake, which is why they have separate
 * config sections, separate names, and opposite defaults:
 *
 *   - **Response caching is OFF by default.** A party game that hands back an
 *     identical deck for an identical prompt is broken, not fast.
 *   - **In-flight coalescing is ON by default.** Five guests tapping "generate"
 *     on the same screen at the same moment is one intent, not five, and it
 *     should cost one call. Coalescing collapses concurrent *identical* requests
 *     without ever reusing a completed result, so it saves the money without
 *     costing the variety. That asymmetry is the whole design.
 */
import type { AiPackageConfig } from '../config';
import type { AiLogger } from '../provider/types';
import type { AiCacheAdapter } from './seams';

export interface ResponseCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  /** Join an identical request that is already in flight. */
  inFlight<T>(key: string, run: () => Promise<T>): Promise<T>;
  readonly enabled: boolean;
}

interface MemoryEntry {
  value: unknown;
  expiresAt: number;
}

export function createResponseCache(
  config: AiPackageConfig,
  adapter: AiCacheAdapter | null | undefined,
  logger?: AiLogger,
): ResponseCache {
  const { enabled, coalesce, store } = config.responseCache;
  const pending = new Map<string, Promise<unknown>>();

  // Fall back to an in-process Map when the configured store isn't wired up.
  // Correct for a single-process home server, and the app is told rather than
  // silently getting a cache that isn't shared across replicas.
  const memory = new Map<string, MemoryEntry>();
  const usable = adapter?.isReady() ? adapter : null;
  if (enabled && store !== 'memory' && !usable) {
    logger?.warn(
      `ai: responseCache.store is '${store}' but no ready cache adapter is registered — ` +
        `falling back to an in-process cache. It will not be shared across processes.`,
      { store },
    );
  }

  const namespaced = (key: string): string => `slingshot-ai:response:${key}`;

  return {
    enabled,

    async get<T>(key: string): Promise<T | undefined> {
      if (usable) {
        try {
          const raw = await usable.get(namespaced(key));
          return raw === null ? undefined : (JSON.parse(raw) as T);
        } catch (error) {
          // A cache is an optimization. A broken one must degrade to a cache
          // miss, never to a failed generation.
          logger?.warn(`ai: response cache read failed; treating as a miss`, {
            error: (error as Error).message,
          });
          return undefined;
        }
      }

      const hit = memory.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt <= Date.now()) {
        memory.delete(key);
        return undefined;
      }
      return hit.value as T;
    },

    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      if (usable) {
        try {
          await usable.set(namespaced(key), JSON.stringify(value), ttlSeconds);
        } catch (error) {
          logger?.warn(`ai: response cache write failed; the result is still returned`, {
            error: (error as Error).message,
          });
        }
        return;
      }
      memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },

    async inFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
      if (!coalesce) return run();

      const existing = pending.get(key) as Promise<T> | undefined;
      if (existing) return existing;

      const promise = run().finally(() => pending.delete(key));
      pending.set(key, promise as Promise<unknown>);
      return promise;
    },
  };
}

/** Stable cache key over everything that could change the answer. */
export function responseCacheKey(parts: {
  provider: string;
  model: string;
  system: readonly { text: string }[];
  messages: readonly { role: string; content: string }[];
  maxTokens: number;
  schemaName?: string;
}): string {
  const source = JSON.stringify([
    parts.provider,
    parts.model,
    parts.system.map(block => block.text),
    parts.messages.map(message => [message.role, message.content]),
    parts.maxTokens,
    parts.schemaName ?? null,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
