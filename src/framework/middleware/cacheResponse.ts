import { getMongooseModule } from '@lib/mongo';
import type { MiddlewareHandler } from 'hono';
import type { Connection } from 'mongoose';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import {
  getCacheAdapter,
  getCacheAdapterOrNull,
  getSlingshotCtx,
} from '@lastshotlabs/slingshot-core';
import type { CacheStoreName } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Mongo cache model (lazy — only registered when "mongo" store is used)
// ---------------------------------------------------------------------------

interface CacheDoc {
  key: string;
  value: string;
  expiresAt?: Date;
}

/**
 * Get or create the Mongoose CacheEntry model on the given connection.
 * Accepts connection and mongoose module as parameters — no module-level state.
 */
export function getCacheModel(conn?: Connection): import('mongoose').Model<CacheDoc> {
  // When called without args (from registerBoundaryAdapters), the model
  // must already be registered on the connection from a prior call.
  // This is a lazy model that gets created on first use with a connection.
  if (!conn) {
    // Fallback: the model must have been registered already on some connection.
    // This path is only hit from registerBoundaryAdapters where appConnection is passed
    // through the closure. We need to accept the connection as parameter.
    throw new Error('getCacheModel requires a connection parameter');
  }
  if (Object.hasOwn(conn.models, 'CacheEntry'))
    return conn.models['CacheEntry'] as unknown as import('mongoose').Model<CacheDoc>;
  const mg = getMongooseModule();
  const { Schema } = mg;
  const cacheSchema = new Schema<CacheDoc>(
    {
      key: { type: String, required: true, unique: true },
      value: { type: String, required: true },
      expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
    },
    { collection: 'cache_entries' },
  );
  return conn.model<CacheDoc>('CacheEntry', cacheSchema);
}

// ---------------------------------------------------------------------------
// Shared payload type
// ---------------------------------------------------------------------------

type CachePayload = { status: number; headers: Record<string, string>; body: string };

// ---------------------------------------------------------------------------
// Store adapters — delegate to registered CacheAdapter instances
// ---------------------------------------------------------------------------

type CacheStore = CacheStoreName;

/**
 * Retrieve a cached string value from the named cache store.
 *
 * @param ctx - The per-request `SlingshotContext` used to locate the cache adapter.
 * @param store - The cache backend to query (e.g. `"redis"`, `"memory"`).
 * @param cacheKey - Fully-qualified cache key (already namespaced).
 * @returns The cached string, or `null` on a cache miss.
 * @throws {Error} If the adapter for `store` reports `isReady() === false`.
 */
async function storeGet(
  ctx: AppEnv['Variables']['slingshotCtx'],
  store: CacheStore,
  cacheKey: string,
): Promise<string | null> {
  const adapter = getCacheAdapter(ctx, store);
  if (!adapter.isReady()) {
    throw new Error(`cacheResponse: store "${store}" is not ready.`);
  }
  return adapter.get(cacheKey);
}

/**
 * Write a string value to the named cache store, with an optional TTL.
 *
 * @param ctx - The per-request `SlingshotContext` used to locate the cache adapter.
 * @param store - The cache backend to write to.
 * @param cacheKey - Fully-qualified cache key (already namespaced).
 * @param value - Serialised payload to cache (JSON string).
 * @param ttl - Optional time-to-live in **seconds**.  Omit for indefinite storage.
 * @throws {Error} If the adapter for `store` reports `isReady() === false`.
 */
async function storeSet(
  ctx: AppEnv['Variables']['slingshotCtx'],
  store: CacheStore,
  cacheKey: string,
  value: string,
  ttl?: number,
): Promise<void> {
  const adapter = getCacheAdapter(ctx, store);
  if (!adapter.isReady()) {
    throw new Error(`cacheResponse: store "${store}" is not ready.`);
  }
  await adapter.set(cacheKey, value, ttl);
}

/**
 * Delete a single cache entry by exact key from the named store.
 *
 * Silently does nothing if the adapter is absent or not ready.
 *
 * @param app - The Hono app instance (used to resolve the cache adapter).
 * @param store - The cache backend to target.
 * @param cacheKey - Fully-qualified cache key to delete.
 */
async function storeDel(app: object, store: CacheStore, cacheKey: string): Promise<void> {
  const adapter = getCacheAdapterOrNull(app, store);
  if (!adapter?.isReady()) return;
  await adapter.del(cacheKey);
}

/**
 * Delete all cache entries whose keys match a glob pattern from the named store.
 *
 * Silently does nothing if the adapter is absent or not ready.
 *
 * @param app - The Hono app instance (used to resolve the cache adapter).
 * @param store - The cache backend to target.
 * @param fullPattern - Fully-qualified glob pattern (e.g. `"cache:myapp:users:*"`).
 */
async function storeDelPattern(app: object, store: CacheStore, fullPattern: string): Promise<void> {
  const adapter = getCacheAdapterOrNull(app, store);
  if (!adapter?.isReady()) return;
  await adapter.delPattern(fullPattern);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Delete a cached entry by exact key across ALL cache backends.
 *
 * Requires an app reference so cache invalidation uses the correct instance-owned adapters.
 *
 * @param key - The cache key to invalidate (without the `cache:<appName>:` prefix).
 * @param app - The Hono app instance used to resolve cache adapters.
 */
export const bustCache = async (key: string, app: object) => {
  const { getContext } = await import('@lastshotlabs/slingshot-core');
  const ctx = getContext(app);
  const appName = ctx.config.appName;
  const cacheKey = `cache:${appName}:${key}`;
  const stores = [...ctx.cacheAdapters.keys()] as CacheStore[];
  await Promise.all(stores.map(store => storeDel(app, store, cacheKey)));
};

/**
 * Delete cached entries matching a glob pattern across ALL cache backends.
 *
 * @param pattern - A glob pattern to match cache keys (without the `cache:<appName>:` prefix).
 * @param app - The Hono app instance used to resolve cache adapters.
 */
export const bustCachePattern = async (pattern: string, app: object) => {
  const { getContext } = await import('@lastshotlabs/slingshot-core');
  const ctx = getContext(app);
  const appName = ctx.config.appName;
  const fullPattern = `cache:${appName}:${pattern}`;
  const stores = [...ctx.cacheAdapters.keys()] as CacheStore[];
  await Promise.all(stores.map(store => storeDelPattern(app, store, fullPattern)));
};

/** Headers that must never be cached — storing these can cause session fixation or auth bypass. */
const UNCACHEABLE_HEADERS = Object.freeze(
  new Set([
    'set-cookie',
    'www-authenticate',
    'authorization',
    'x-csrf-token',
    'proxy-authenticate',
  ]),
);

type KeyFn = (c: Parameters<MiddlewareHandler>[0]) => string;

interface CacheOptions {
  ttl?: number; // seconds — omit for indefinite
  key: string | KeyFn;
  store?: CacheStore; // default: read from SlingshotContext resolvedStores.cache, falls back to "redis"
}

/**
 * Hono middleware that caches full HTTP responses in a configured backend store.
 *
 * On a **cache hit** the cached status, headers, and body are returned immediately
 * with an `x-cache: HIT` header — the downstream route handler is not called.
 * On a **cache miss** the route handler runs normally; if the response status is
 * 2xx the response is serialised and stored, then re-sent with `x-cache: MISS`.
 * Non-2xx responses are never cached.
 *
 * Cache keys are automatically namespaced by `appName` and, when present, by
 * `tenantId`, so two tenants can never observe each other's cached responses.
 *
 * Security: the following response headers are **never** stored in the cache to
 * prevent session fixation, CSRF token leakage, and auth bypass:
 * `set-cookie`, `www-authenticate`, `authorization`, `x-csrf-token`,
 * `proxy-authenticate`.
 *
 * @param options - Cache configuration.
 * @param options.key - Cache key string or a function `(c) => string` that
 *   derives a key from the request context.  The value is automatically
 *   prefixed with `cache:<appName>:[tenantId:]`.
 * @param options.ttl - Time-to-live in **seconds**.  Omit for indefinite caching.
 * @param options.store - Override the cache backend.  Defaults to
 *   `ctx.config.resolvedStores.cache`, falling back to `"redis"`.
 * @returns A Hono `MiddlewareHandler` that serves cached responses or populates
 *   the cache after a fresh response from the route handler.
 * @throws {Error} If the resolved cache adapter reports `isReady() === false`
 *   at request time.
 *
 * @example
 * ```ts
 * // Cache the /products list for 60 seconds, keyed by tenant
 * router.get('/products', cacheResponse({ key: 'products:list', ttl: 60 }), handler);
 *
 * // Dynamic key derived from path parameters
 * router.get('/products/:id', cacheResponse({ key: c => `product:${c.req.param('id')}` }), handler);
 * ```
 */
export const cacheResponse = ({
  ttl,
  key,
  store: storeOverride,
}: CacheOptions): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const ctx = getSlingshotCtx(c);
    const store: CacheStore = storeOverride ?? (ctx.config.resolvedStores.cache as CacheStore);
    const appName = ctx.config.appName;
    const rawKey = typeof key === 'function' ? key(c) : key;
    // Per-tenant namespacing: prevents two tenants caching the same key from colliding
    const tenantId = c.get('tenantId');
    const tenantSegment = tenantId ? `${tenantId}:` : '';
    const cacheKey = `cache:${appName}:${tenantSegment}${rawKey}`;

    const cached = await storeGet(ctx, store, cacheKey);
    if (cached) {
      const { status, headers, body } = JSON.parse(cached) as CachePayload;
      return new Response(body, {
        status,
        headers: { ...headers, 'x-cache': 'HIT' },
      });
    }

    await next();

    const res = c.res;
    if (res.status >= 200 && res.status < 300) {
      const body = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((value, name) => {
        if (!UNCACHEABLE_HEADERS.has(name.toLowerCase())) {
          headers[name] = value;
        }
      });

      await storeSet(
        ctx,
        store,
        cacheKey,
        JSON.stringify({ status: res.status, headers, body }),
        ttl,
      );

      c.res = new Response(body, {
        status: res.status,
        headers: { ...headers, 'x-cache': 'MISS' },
      });
    }
  };
};
