import type { TenancyConfig, TenantConfig } from '@config/types/tenancy';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { getContext } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Simple LRU cache with TTL
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: TenantConfig | null;
  expiresAt: number;
}

/**
 * A fixed-capacity in-memory LRU cache with per-entry TTL.
 *
 * Entries are evicted in least-recently-used order when the cache reaches
 * `maxSize`.  Expired entries are lazily removed on read (no background timer).
 * Used internally by `createTenantMiddleware` to cache resolved `TenantConfig`
 * objects and avoid redundant `onResolve` calls.
 */
class LruCache {
  private _map = new Map<string, CacheEntry>();
  private _maxSize: number;
  private _ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this._maxSize = maxSize;
    this._ttlMs = ttlMs;
  }

  /**
   * Retrieve a cached value by key.
   *
   * Accessing an entry promotes it to the most-recently-used position.
   * Expired entries are deleted on access and treated as a miss.
   *
   * @param key - The tenant ID to look up.
   * @returns The cached `TenantConfig` (or `null` for a known-invalid tenant),
   *   or `undefined` on a cache miss (key absent or expired).
   */
  get(key: string): TenantConfig | null | undefined {
    const entry = this._map.get(key);
    if (!entry) return undefined; // cache miss
    if (entry.expiresAt <= Date.now()) {
      this._map.delete(key);
      return undefined; // expired
    }
    // Move to end (most recently used)
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  /**
   * Store a resolved `TenantConfig` (or `null` for an invalid tenant) in the cache.
   *
   * If the cache is at capacity the oldest entry (LRU) is evicted before
   * inserting the new one.  Re-inserting an existing key refreshes its
   * position and resets the TTL.
   *
   * @param key - The tenant ID.
   * @param value - The resolved `TenantConfig`, or `null` to cache a negative
   *   lookup (tenant rejected by `onResolve`).
   */
  set(key: string, value: TenantConfig | null): void {
    // Remove first if exists (for re-insertion at end)
    this._map.delete(key);
    // Evict oldest if at capacity
    if (this._map.size >= this._maxSize) {
      const oldest = this._map.keys().next().value;
      if (oldest !== undefined) this._map.delete(oldest);
    }
    this._map.set(key, { value, expiresAt: Date.now() + this._ttlMs });
  }

  /**
   * Remove an entry from the cache by key.
   *
   * Does nothing if the key is not present.
   *
   * @param key - The tenant ID to invalidate.
   */
  delete(key: string): void {
    this._map.delete(key);
  }
}

/**
 * Interface for a pluggable tenant-resolution cache.
 *
 * The default implementation is the internal `LruCache` class.  Expose this
 * interface to allow custom cache backends (e.g. Redis-backed caches) in
 * advanced multi-tenant scenarios.
 *
 * Return semantics for `get`:
 * - `TenantConfig` — valid, resolved tenant (cache hit).
 * - `null` — known-invalid tenant (negative cache hit — skip `onResolve`).
 * - `undefined` — cache miss (call `onResolve`).
 */
export interface TenantResolutionCache {
  /** Look up a tenant.  Returns `undefined` on a miss, `null` on a negative hit. */
  get(key: string): TenantConfig | null | undefined;
  /** Store a resolved tenant config (or `null` for a rejected tenant). */
  set(key: string, value: TenantConfig | null): void;
  /** Remove a tenant entry, forcing re-resolution on the next request. */
  delete(key: string): void;
}

/**
 * A mutable carrier object that holds the live `TenantResolutionCache` instance
 * created by `createTenantMiddleware`.
 *
 * Pass a carrier to `createTenantMiddleware` to get a reference to the cache
 * after middleware setup, enabling programmatic cache invalidation via
 * `invalidateTenantCache`.  If `onResolve` is absent or `cacheTtlMs` is 0 the
 * cache will be `null`.
 */
export interface TenantCacheCarrier {
  /** The live cache instance, or `null` if caching is disabled. */
  cache: TenantResolutionCache | null;
}

// ---------------------------------------------------------------------------
// Exported cache invalidation (used by tenant provisioning helpers)
// ---------------------------------------------------------------------------

/**
 * Immediately remove a specific tenant from the resolution cache.
 *
 * Call this after provisioning, updating, or disabling a tenant so that the
 * next request for that tenant calls `onResolve` instead of serving a stale
 * cached result.
 *
 * @param cache - The `TenantResolutionCache` obtained from a
 *   `TenantCacheCarrier`, or `null`/`undefined` if caching is disabled
 *   (safe to call either way).
 * @param tenantId - The ID of the tenant whose cache entry should be removed.
 */
export const invalidateTenantCache = (
  cache: TenantResolutionCache | null | undefined,
  tenantId: string,
): void => {
  cache?.delete(tenantId);
};

/**
 * Retrieve the live `TenantResolutionCache` that was created for the given app.
 *
 * The cache is stored in `SlingshotContext.pluginState` under the key
 * `"tenantResolutionCache"` by the framework bootstrap layer.  Returns `null`
 * if caching was disabled (no `onResolve` callback, or `cacheTtlMs` is 0).
 *
 * @param app - The Hono app instance (or any object that satisfies the
 *   `getContext` lookup key).
 * @returns The live `TenantResolutionCache`, or `null` if not available.
 */
export function getTenantCacheFromApp(app: object): TenantResolutionCache | null {
  const ctx = getContext(app);
  return (
    (ctx.pluginState.get('tenantResolutionCache') as TenantResolutionCache | null | undefined) ??
    null
  );
}

// ---------------------------------------------------------------------------
// Tenant resolution middleware
// ---------------------------------------------------------------------------

const DEFAULT_EXEMPT = ['/health', '/docs', '/openapi.json', '/auth/'];

function extractTenantId(
  c: Parameters<MiddlewareHandler>[0],
  config: TenancyConfig,
): string | null {
  if (config.resolution === 'header') {
    const headerName = config.headerName ?? 'x-tenant-id';
    return c.req.header(headerName) ?? null;
  }

  if (config.resolution === 'subdomain') {
    const host = c.req.header('host') ?? '';
    // Extract first subdomain: "acme.myapp.com" → "acme"
    const parts = host.split('.');
    if (parts.length < 3) return null; // no subdomain
    return parts[0] || null;
  }

  const segmentIndex = config.pathSegment ?? 0;
  // Path: "/acme/api/users" → segments after split: ["", "acme", "api", "users"]
  const segments = c.req.path.split('/').filter(Boolean);
  return segments[segmentIndex] ?? null;
}

/**
 * Create the tenant-resolution Hono middleware for a multi-tenant application.
 *
 * Extracts a tenant ID from each request using the strategy defined in `config`
 * (`"header"`, `"subdomain"`, or `"path"`), then optionally validates the ID
 * via the `onResolve` callback.  Resolved `TenantConfig` objects are cached in
 * an in-process LRU cache (configurable via `cacheTtlMs` and `cacheMaxSize`).
 *
 * Paths listed in `config.exemptPaths` (plus hard-coded defaults such as
 * `/health` and `/auth/`) bypass tenant extraction entirely and proceed with
 * `tenantId` and `tenantConfig` both set to `null`.
 *
 * Security notes:
 * - When `onResolve` is absent the tenant ID is trusted without validation.
 *   This is acceptable for development but must not be used in production —
 *   `mountTenantMiddleware` enforces this and throws in production mode.
 * - Tenant ID resolution runs **after** plugin middleware (including auth)
 *   so that auth plugins can set context variables before tenant lookup.
 *
 * @param config - Tenancy configuration.  See `TenancyConfig` for all options.
 * @param carrier - Optional mutable object that will be populated with the
 *   created cache instance so callers can call `invalidateTenantCache` later.
 * @returns A Hono `MiddlewareHandler` that sets `c.get('tenantId')` and
 *   `c.get('tenantConfig')` on every non-exempt request.
 * @throws Responds with `400` when no tenant ID can be extracted and
 *   `config.rejectionStatus` (default `403`) when `onResolve` returns `null`.
 */
export const createTenantMiddleware = (
  config: TenancyConfig,
  carrier?: TenantCacheCarrier,
): MiddlewareHandler<AppEnv> => {
  const exemptPaths = [...DEFAULT_EXEMPT, ...(config.exemptPaths ?? [])];
  const rejectionStatus = config.rejectionStatus ?? 403;
  const cacheTtlMs = config.cacheTtlMs ?? 60_000;
  const cacheMaxSize = config.cacheMaxSize ?? 500;
  const cache = config.onResolve && cacheTtlMs > 0 ? new LruCache(cacheMaxSize, cacheTtlMs) : null;
  if (carrier) carrier.cache = cache;

  return async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      return next();
    }

    const path = c.req.path;

    // Exempt exact matches and sub-paths (with segment boundary).
    // Use "<exempt>/" as the prefix so "/auth" doesn't accidentally exempt
    // "/authenticate" or "/authorization-bypass". Entries already ending in "/"
    // (e.g. "/auth/") are handled correctly by the exact-match branch too.
    for (const exempt of exemptPaths) {
      const prefix = exempt.endsWith('/') ? exempt : exempt + '/';
      if (path === exempt || path.startsWith(prefix)) {
        c.set('tenantId', null);
        c.set('tenantConfig', null);
        return next();
      }
    }

    const tenantId = extractTenantId(c, config);
    if (!tenantId) {
      return c.json({ error: 'Tenant ID required' }, 400);
    }

    // Validate via onResolve (with caching)
    if (config.onResolve) {
      let tenantConfig: TenantConfig | null | undefined;

      if (cache) {
        tenantConfig = cache.get(tenantId);
      }

      // undefined = cache miss, null = onResolve returned null (rejected)
      if (tenantConfig === undefined) {
        tenantConfig = await config.onResolve(tenantId);
        cache?.set(tenantId, tenantConfig);
      }

      if (tenantConfig === null) {
        return c.json({ error: 'Access denied' }, rejectionStatus);
      }

      c.set('tenantId', tenantId);
      c.set('tenantConfig', tenantConfig);
    } else {
      // No onResolve — trust the tenant ID (development/testing only)
      c.set('tenantId', tenantId);
      c.set('tenantConfig', null);
    }

    return next();
  };
};
