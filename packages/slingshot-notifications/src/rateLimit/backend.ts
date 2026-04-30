/**
 * Notification-scoped rate-limit backend contract.
 */
export interface RateLimitBackend {
  check(key: string, limit: number, windowMs: number): Promise<boolean>;
  clear?(): void;
  close?(): Promise<void>;
}

/**
 * Closure-owned in-memory fixed-window backend.
 */
export function createInMemoryRateLimitBackend(): RateLimitBackend {
  interface Entry {
    count: number;
    windowStart: number;
  }

  const entries = new Map<string, Entry>();

  return {
    check(key, limit, windowMs) {
      const now = Date.now();
      const entry = entries.get(key);
      if (!entry || now - entry.windowStart >= windowMs) {
        entries.set(key, { count: 1, windowStart: now });
        return Promise.resolve(true);
      }

      if (entry.count >= limit) return Promise.resolve(false);
      entry.count += 1;
      return Promise.resolve(true);
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * Backend that never rate-limits.
 */
export function createNoopRateLimitBackend(): RateLimitBackend {
  return {
    check() {
      return Promise.resolve(true);
    },
  };
}

// ---------------------------------------------------------------------------
// Redis-backed implementation
// ---------------------------------------------------------------------------

/** Chainable transaction builder structurally compatible with ioredis. */
export interface RedisMultiLike {
  incr(key: string): RedisMultiLike;
  pexpire(key: string, ms: number, nx: 'NX'): RedisMultiLike;
  exec(): Promise<unknown[] | null>;
}

/** Minimal structural Redis client used by {@link createRedisRateLimitBackend}. */
export interface RedisClientLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  multi(): RedisMultiLike;
}

/** Options for {@link createRedisRateLimitBackend}. */
export interface CreateRedisRateLimitBackendOptions {
  /** Redis client instance. */
  client: RedisClientLike;
  /** Optional key prefix. Defaults to `slingshot:notif:rl:`. */
  keyPrefix?: string;
}

const DEFAULT_NOTIF_KEY_PREFIX = 'slingshot:notif:rl:';

/**
 * Build a Redis-backed notification rate-limit backend.
 *
 * Uses MULTI + INCR + PEXPIRE NX so the counter increment and TTL
 * initialisation happen atomically and the window cannot be silently
 * extended by concurrent checks.
 *
 * Register in multi-instance deploys via {@link registerRateLimitBackend}:
 *
 * @example
 * ```ts
 * import { registerRateLimitBackend, createRedisRateLimitBackend } from '@lastshotlabs/slingshot-notifications/rateLimit';
 * import Redis from 'ioredis';
 *
 * const redis = new Redis();
 * registerRateLimitBackend('redis', () => createRedisRateLimitBackend({ client: redis }));
 * ```
 */
export function createRedisRateLimitBackend(
  opts: CreateRedisRateLimitBackendOptions,
): RateLimitBackend {
  const { client } = opts;
  const prefix = opts.keyPrefix ?? DEFAULT_NOTIF_KEY_PREFIX;

  return {
    async check(key, limit, windowMs) {
      const fullKey = `${prefix}${key}`;
      const tx = client.multi();
      tx.incr(fullKey);
      tx.pexpire(fullKey, windowMs, 'NX');
      const results = await tx.exec();

      let count: number;
      if (results == null || results.length < 1) {
        // Transaction aborted — fall back to a single INCR.
        count = await client.incr(fullKey);
        await client.pexpire(fullKey, windowMs).catch(() => {});
      } else {
        const raw = results[0];
        const parsed = Array.isArray(raw) ? (raw[1] as number) : (raw as number);
        count =
          typeof parsed === 'number' && Number.isFinite(parsed)
            ? parsed
            : await client.incr(fullKey);
      }

      return count <= limit;
    },

    async close() {
      // Redis client lifecycle is managed externally — nothing to tear down.
    },
  };
}
