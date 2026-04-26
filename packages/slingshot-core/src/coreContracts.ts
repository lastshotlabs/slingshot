import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Actor, IdentityResolver } from './identity';

/**
 * Auth middleware registry provided by the auth plugin to the framework.
 *
 * Framework-owned routes (jobs, metrics, uploads) retrieve this registry
 * via `getRouteAuth()` to apply auth and role guards without depending on
 * the auth plugin directly.
 */
export interface RouteAuthRegistry {
  /**
   * Hono middleware that enforces a valid user session.
   *
   * @remarks
   * Reads the session from whatever mechanism the auth plugin is configured to use
   * (cookie session, JWT bearer, etc.). Always present — every auth deployment
   * provides session enforcement. Responds with HTTP 401 if the request carries
   * no valid session; passes through to the next handler if authenticated.
   */
  userAuth: MiddlewareHandler;
  /**
   * Produce a Hono middleware that requires the authenticated user to hold at least one of the given roles.
   *
   * @param roles - One or more role strings. The check passes when the user holds
   *   **any** of the provided roles (OR semantics). For AND semantics, chain
   *   multiple `requireRole()` middlewares in sequence.
   * @returns A Hono `MiddlewareHandler` that responds with HTTP 403 when the role
   *   check fails and calls `next()` when it passes.
   * @remarks
   * Must be called after `userAuth` in the middleware chain — the role check reads
   * identity information that `userAuth` places on the Hono context. Calling it
   * without a prior `userAuth` will result in a 403 (no roles found) rather than
   * a 401.
   */
  requireRole(...roles: string[]): MiddlewareHandler;
  /**
   * Bearer token authentication middleware.
   *
   * @remarks
   * Only present when bearer tokens are configured on the auth plugin (i.e., when
   * `auth.bearerTokens` or `auth.m2m` is enabled). Callers **must** check for its
   * presence before applying it — `applyRouteConfig()` does this automatically.
   * Responds with HTTP 401 if the `Authorization: Bearer <token>` header is absent
   * or the token is invalid/expired.
   */
  bearerAuth?: MiddlewareHandler;
  /**
   * Post-authentication guards invoked after `userAuth` succeeds but before
   * the route handler runs.
   *
   * @remarks
   * Guards run in registration order. The first guard that returns a non-null
   * `PostAuthGuardFailure` short-circuits the request with that error response.
   * If all guards return `null`, the request proceeds normally.
   *
   * Registered by the auth plugin during `setupPost`. Entity routes, package
   * routes, and framework-owned routes iterate this array when `auth` is set
   * to `'userAuth'`.
   */
  postGuards?: readonly PostAuthGuard[];
}

/**
 * Result returned by a post-auth guard when the request should be rejected.
 */
export interface PostAuthGuardFailure {
  /** Machine-readable error code (e.g. `'ACCOUNT_SUSPENDED'`). */
  error: string;
  /** Human-readable description suitable for API response bodies. */
  message: string;
  /** HTTP status code to return (e.g. `403`). */
  status: ContentfulStatusCode;
}

/**
 * A guard function invoked after auth middleware succeeds but before
 * the route handler runs.
 *
 * Post-auth guards run in registration order. The first guard that returns
 * a non-null `PostAuthGuardFailure` short-circuits the request with that
 * error. If all guards return `null`, the request continues to the handler.
 */
export type PostAuthGuard = (c: Context<any, any>) => Promise<PostAuthGuardFailure | null>;

/**
 * Resolves the authenticated `Actor` from a raw HTTP request.
 *
 * Used by framework WebSocket and SSE upgrade handlers to identify the connecting
 * actor without depending on the auth plugin. Registered by the auth plugin during
 * `setupPost`.
 */
export interface RequestActorResolver {
  /**
   * Extract the authenticated `Actor` from the request.
   *
   * @param req - The raw inbound `Request`. Implementations inspect whichever
   *   credential source is appropriate for the auth plugin's configuration —
   *   typically a signed session cookie, a `Cookie` header containing a session
   *   token, or an `Authorization: Bearer` header for token-based setups.
   * @returns The authenticated `Actor`. Unauthenticated, expired, or unverifiable
   *   requests resolve to `ANONYMOUS_ACTOR` (`{ id: null, kind: 'anonymous', ... }`),
   *   never `null`.
   * @remarks
   * Auth failure is signalled by resolving to `ANONYMOUS_ACTOR`, not by throwing.
   * Callers (WebSocket / SSE upgrade handlers) decide whether anonymous connections
   * are allowed. Implementations must not throw on invalid/missing credentials —
   * only on unexpected infrastructure errors (e.g., a Redis connection failure).
   */
  resolveActor(req: Request): Promise<Actor>;
}

/**
 * Per-key request rate limiting contract.
 *
 * Tracks attempt counts within a rolling time window. Returns `true` when the limit
 * has been exceeded (the caller should respond with 429).
 */
export interface RateLimitAdapter {
  /**
   * Atomically increment the attempt counter for `key` and return whether the limit
   * has been exceeded.
   *
   * @param key - The rate limit bucket key. Conventionally namespaced by action and
   *   identifier, e.g. `'login:1.2.3.4'` or `'otp:user_abc123'`.
   * @param opts - Window configuration:
   *   - `windowMs` — rolling window duration in milliseconds.
   *   - `max` — maximum number of attempts allowed within the window.
   * @returns `true` on the **first call that crosses the threshold** (`count > max`)
   *   and on every subsequent call within the same window. Returns `false` while
   *   `count <= max`. Callers should respond with HTTP 429 when `true` is returned.
   * @remarks
   * The increment and threshold check must be atomic (single Redis command,
   * single transaction, etc.) to avoid race conditions under concurrent requests.
   * The method is NOT idempotent — every call increments the counter regardless of
   * the return value. Implementations must set the window TTL on the first increment
   * so the counter resets automatically after `windowMs`.
   */
  trackAttempt(key: string, opts: { windowMs: number; max: number }): Promise<boolean>;
}

/**
 * Builds a short fingerprint hash from stable HTTP request headers.
 * Used for unauthenticated bot detection and request fingerprinting.
 */
export interface FingerprintBuilder {
  /**
   * Produce a stable fingerprint string from the request's headers.
   *
   * @param req - The inbound HTTP request. Implementations read stable headers
   *   such as `User-Agent`, `Accept-Language`, `Accept-Encoding`, and the
   *   client IP address (from `CF-Connecting-IP`, `X-Forwarded-For`, or
   *   `request.socket.remoteAddress`) to build the fingerprint.
   * @returns A short hash string (e.g., a 12-character hex digest from SHA-256
   *   truncation). The value must be deterministic for the same header set.
   * @remarks
   * **Stability** — the fingerprint must remain identical across requests from
   * the same client within a session. Avoid including headers that change
   * per-request (e.g., `Cookie`, `Authorization`, `Content-Length`).
   *
   * **Collision risk** — fingerprints are not unique identifiers. Two different
   * clients can produce the same fingerprint (e.g., users behind the same NAT
   * with identical browser settings). Use fingerprints only for coarse bot
   * detection and rate-limiting, never for authentication or authorisation.
   *
   * **IP-only vs. enriched** — the default implementation uses IP address alone.
   * Replacing the builder via `CoreRegistrar.setFingerprintBuilder()` allows
   * richer header sets to reduce false-positive collisions.
   */
  buildFingerprint(req: Request): Promise<string>;
}

/**
 * Unified key-value cache adapter interface.
 *
 * Implementations wrap a specific backing store (Redis, memory, SQLite, etc.)
 * and expose a consistent get/set/del/delPattern API used by the framework's
 * response caching and session storage middleware.
 */
export interface CacheAdapter {
  /** Human-readable adapter name (e.g., `'redis'`, `'memory'`). Used for logging and diagnostics. */
  readonly name: string;
  /**
   * Retrieve a cached value by key.
   *
   * @param key - The exact cache key to look up.
   * @returns The stored string value, or `null` if the key does not exist or has
   *   expired. Callers that stored JSON should `JSON.parse` the result.
   * @remarks
   * Never throws on a cache miss — always returns `null`. Only throws on
   * infrastructure errors (e.g., broken connection).
   */
  get(key: string): Promise<string | null>;
  /**
   * Store a string value under `key` with an optional TTL.
   *
   * @param key - The cache key. Must be a non-empty string.
   * @param value - The string to store. Callers must serialize objects before
   *   calling (e.g., `JSON.stringify(obj)`).
   * @param ttl - Optional time-to-live in **seconds**. When provided, the entry
   *   is automatically evicted after `ttl` seconds. Omit (or pass `undefined`)
   *   for a non-expiring entry — note that non-expiring entries in Redis will
   *   persist until evicted by maxmemory policy.
   */
  set(key: string, value: string, ttl?: number): Promise<void>;
  /**
   * Delete a single key from the cache.
   *
   * @param key - The cache key to remove.
   * @remarks
   * Safe to call when the key does not exist — implementations must treat this
   * as a no-op rather than throwing.
   */
  del(key: string): Promise<void>;
  /**
   * Delete all keys whose names match a glob pattern.
   *
   * @param pattern - A glob expression. Supported syntax:
   *   - `*` — matches any sequence of characters (including none).
   *   - `?` — matches exactly one character.
   *   - Literal `*` and `?` must be escaped as `\*` and `\?` respectively.
   *   Example: `'session:*'` deletes all keys beginning with `'session:'`.
   * @remarks
   * This operation can be expensive on large key spaces. Avoid broad patterns
   * (e.g., `'*'`) in production. Redis implementations should use `SCAN` +
   * `DEL` rather than `KEYS` to avoid blocking the server. Memory adapters
   * may iterate synchronously since they hold all keys in-process.
   */
  delPattern(pattern: string): Promise<void>;
  /**
   * Return whether the backing store is connected and ready to serve requests.
   *
   * @returns `true` if the adapter can immediately fulfill `get`/`set`/`del`
   *   calls without error; `false` if the connection is down, initializing, or
   *   in a degraded state.
   * @remarks
   * Used by framework health-check endpoints (e.g., `GET /health`). This method
   * is synchronous so it can be called safely in health-check hot paths — do not
   * perform async I/O inside the implementation. Reflect the last known
   * connection state rather than probing the store on every call.
   */
  isReady(): boolean;
}

/**
 * The backing store identifiers for cache adapters.
 * Each value corresponds to a registered `CacheAdapter` in `SlingshotContext.cacheAdapters`.
 */
export type CacheStoreName = 'redis' | 'mongo' | 'sqlite' | 'memory' | 'postgres';

/**
 * A static email template registered by a plugin.
 * Plugins register templates via `CoreRegistrar.addEmailTemplates()` so the mail plugin
 * can render them without importing the plugin directly.
 */
export interface EmailTemplate {
  /**
   * The email subject line.
   *
   * @remarks
   * Must be a plain text string — HTML tags are not rendered in most mail
   * clients' subject fields and should be avoided. Keep under 78 characters
   * to prevent line-folding in SMTP headers (RFC 5322). Required — all
   * registered templates must provide a subject.
   */
  subject: string;
  /**
   * The HTML body of the email.
   *
   * @remarks
   * Must be a complete, self-contained HTML document or fragment safe to embed
   * inside a `<body>` tag. CSS should be inlined — most email clients strip
   * `<style>` blocks. Must be UTF-8 encoded. Required — at minimum the HTML
   * body must be present; the plain-text `text` field is supplementary.
   */
  html: string;
  /**
   * Optional plain-text alternative body.
   *
   * @remarks
   * Rendered as the `text/plain` MIME part when present. Shown by clients that
   * cannot render HTML, or used by spam filters. When omitted, the mail plugin
   * will attempt to strip HTML tags from `html` to produce a fallback, but
   * providing an explicit value yields better readability. No length limit
   * beyond what the mail transport imposes (typically several MB).
   */
  text?: string;
}

/**
 * A frozen snapshot of all auth-boundary dependencies collected by `CoreRegistrar`.
 * Produced by `createCoreRegistrar().drain()` after the plugin lifecycle completes.
 * Written immutably into `SlingshotContext` by `createApp()`.
 */
export interface CoreRegistrarSnapshot {
  readonly identityResolver: IdentityResolver | null;
  readonly routeAuth: RouteAuthRegistry | null;
  readonly actorResolver: RequestActorResolver | null;
  readonly rateLimitAdapter: RateLimitAdapter | null;
  readonly fingerprintBuilder: FingerprintBuilder | null;
  readonly cacheAdapters: ReadonlyMap<CacheStoreName, CacheAdapter>;
  readonly emailTemplates: ReadonlyMap<string, EmailTemplate>;
}

/**
 * Mutable registration interface passed to plugins during their `setupPost` phase.
 *
 * The auth plugin calls these methods to register the framework's auth-boundary
 * dependencies (auth middleware, request actor resolver, rate limiter, cache adapters, email templates).
 * `createApp()` drains the registrar after all plugins run to commit the values to the context.
 *
 * @remarks
 * Each `set*` method replaces the previously registered value — calling the same setter
 * a second time overwrites the first. In practice each setter is called at most once per
 * app instance (by a single plugin). `addCacheAdapter` and `addEmailTemplates` accumulate
 * values rather than replacing them.
 */
export interface CoreRegistrar {
  /**
   * Register a custom identity resolver that maps raw auth context into a canonical `Actor`.
   *
   * @param resolver - An `IdentityResolver` whose `resolve` method produces an `Actor`
   *   from the raw auth context variables set by middleware.
   * @remarks
   * Called by auth plugins during `setupPost`. When no resolver is registered the
   * framework falls back to `createDefaultIdentityResolver()` which preserves
   * existing identity-to-actor mapping behavior. Custom auth integrations (gateway
   * auth, external IdP, Lambda authorizer bridges) register their own resolver so
   * framework consumers get a consistent identity shape without conforming to
   * hardcoded field names. Calling this a second time replaces the previous resolver.
   */
  setIdentityResolver(resolver: IdentityResolver): void;
  /**
   * Register the route auth middleware registry provided by the auth plugin.
   *
   * @param registry - A `RouteAuthRegistry` containing `userAuth`, `requireRole`,
   *   and optionally `bearerAuth` middleware.
   * @remarks
   * Called by the auth plugin during `setupPost`. Framework-owned routes (uploads,
   * jobs, metrics) resolve this registry via `getRouteAuth()` to guard their
   * endpoints without importing the auth plugin. Calling this a second time
   * replaces the previous registry.
   */
  setRouteAuth(registry: RouteAuthRegistry): void;
  /**
   * Register the request actor resolver used by WebSocket and SSE upgrade handlers.
   *
   * @param resolver - A `RequestActorResolver` whose `resolveActor` returns the
   *   authenticated `Actor` for a raw `Request` (or `ANONYMOUS_ACTOR` for
   *   unauthenticated requests).
   * @remarks
   * Called by the auth plugin during `setupPost`. The framework's WebSocket and
   * SSE upgrade paths call `resolveActor()` to identify the connecting actor before
   * upgrading the connection. Calling this a second time replaces the previous resolver.
   */
  setRequestActorResolver(resolver: RequestActorResolver): void;
  /**
   * Replace the default in-memory rate limit adapter with a distributed implementation.
   *
   * @param adapter - A `RateLimitAdapter` whose `trackAttempt` method persists
   *   counters in a shared backing store (e.g., Redis) so limits are enforced
   *   across multiple server instances.
   * @remarks
   * The framework ships a default in-memory adapter suitable for single-instance
   * deployments. Call this during `setupPost` to swap in a distributed adapter.
   * Calling this a second time replaces the previous adapter.
   */
  setRateLimitAdapter(adapter: RateLimitAdapter): void;
  /**
   * Replace the default fingerprint builder with a richer implementation.
   *
   * @param builder - A `FingerprintBuilder` whose `buildFingerprint` method
   *   incorporates additional request headers beyond the default IP-only approach.
   * @remarks
   * The default builder hashes only the client IP address. Replacing it with one
   * that also reads `User-Agent`, `Accept-Language`, etc. reduces false-positive
   * rate-limit collisions for shared-IP environments (e.g., corporate proxies).
   * Calling this a second time replaces the previous builder.
   */
  setFingerprintBuilder(builder: FingerprintBuilder): void;
  /**
   * Register a cache adapter for a named store.
   *
   * @param store - The `CacheStoreName` key (e.g., `'redis'`, `'memory'`).
   *   Each store name may have at most one adapter registered. Calling this
   *   with the same `store` a second time replaces the previous adapter for
   *   that store.
   * @param adapter - The `CacheAdapter` implementation to register.
   * @remarks
   * Multiple adapters can coexist — one per `CacheStoreName`. The framework
   * resolves the appropriate adapter by store name when performing cache
   * operations. The auth plugin typically registers a Redis adapter when
   * `auth.session.store` is `'redis'`.
   */
  addCacheAdapter(store: CacheStoreName, adapter: CacheAdapter): void;
  /**
   * Register one or more static email templates that the mail plugin can render.
   *
   * @param templates - A map of template identifier to `EmailTemplate`. Keys are
   *   plain string identifiers (e.g., `'welcome'`, `'password-reset'`). These
   *   keys are used by the mail plugin to look up templates at send time.
   * @remarks
   * Accumulates templates across calls — subsequent calls add to (or overwrite
   * individual keys in) the existing template map rather than replacing it
   * entirely. Plugins should call this during `setupPost` after confirming the
   * mail plugin is present.
   */
  addEmailTemplates(templates: Record<string, EmailTemplate>): void;
}
