/**
 * The RESPONSE cache — a different thing from the PROMPT cache.
 *
 *   prompt cache   → the provider stores your prefix; you still make the call
 *                    and still get fresh output. Saves money.
 *   response cache → we don't make the call at all; you get the same answer as
 *                    last time. Saves money AND removes variety.
 *
 * Conflating the two is the expensive mistake, which is why they have separate
 * config sections and separate names. The response cache is OFF by default: a
 * party game that returns an identical deck to the same prompt is broken, not
 * fast.
 *
 * Memory store only, here. F4 adds redis/sqlite/postgres behind this interface.
 */
import type { AiPackageConfig } from '../config';

export interface ResponseCache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlSeconds: number): void;
  /** Coalescing: join an identical request that is already in flight. */
  inFlight<T>(key: string, run: () => Promise<T>): Promise<T>;
  readonly enabled: boolean;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

export function createResponseCache(config: AiPackageConfig): ResponseCache {
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<unknown>>();
  const { enabled } = config.responseCache;

  return {
    enabled,

    get<T>(key: string): T | undefined {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return hit.value as T;
    },

    set<T>(key: string, value: T, ttlSeconds: number): void {
      entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },

    async inFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
      if (!config.responseCache.coalesce) return run();
      const existing = pending.get(key) as Promise<T> | undefined;
      if (existing) return existing;

      const promise = run().finally(() => pending.delete(key));
      pending.set(key, promise as Promise<unknown>);
      return promise;
    },
  };
}

/** Stable cache key. Order-independent over the parts that matter, and cheap. */
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
