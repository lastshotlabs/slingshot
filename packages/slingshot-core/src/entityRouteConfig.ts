// ============================================================================
// Entity Route Configuration — declarative per-entity route wiring.
//
// Consumed by applyRouteConfig() at runtime to wire auth, permissions,
// rate limits, events, and custom middleware onto a Hono router.
// ============================================================================

/**
 * Authentication strategy for a route or operation.
 *
 * - `'userAuth'` — requires a valid session cookie or user token (via `RouteAuthRegistry.userAuth`)
 * - `'bearer'`   — requires a bearer token (via `RouteAuthRegistry.bearerAuth`)
 * - `'none'`     — publicly accessible; no auth middleware applied
 *
 * @remarks
 * Set on `EntityRouteConfig.defaults` to apply the same auth strategy to all generated
 * CRUD routes, then override individual operations (e.g. `list: { auth: 'none' }`) as needed.
 * The framework wires the corresponding middleware from `RouteAuthRegistry` automatically —
 * you never call the middleware factory directly.
 *
 * @example
 * ```ts
 * const routes: EntityRouteConfig = {
 *   defaults: { auth: 'userAuth' }, // all ops require a session by default
 *   list:     { auth: 'none' },     // public listing
 * };
 * ```
 */
export type RouteAuthConfig = 'userAuth' | 'bearer' | 'none';

// --- Policy Hooks ---

/**
 * The operation a policy resolver is being asked to authorize.
 *
 * Discriminated union — the `kind` field tells the resolver what to expect
 * in the other `PolicyInput` fields:
 *
 * - `'create'`     — `input` is the create payload; `record` is `null`.
 * - `'list'`       — `record` and `input` are both `null`. Resolvers on
 *                    list operations gate **whether the list route is
 *                    callable at all**; per-row filtering uses `dataScope`
 *                    or a named op with explicit filter logic.
 * - `'get'`        — `record` is the fetched row; `input` is `null`.
 * - `'update'`     — `record` is the fetched row; `input` is the update
 *                    payload. Policy runs AFTER `dataScope` has matched.
 * - `'delete'`     — `record` is the fetched row; `input` is `null`.
 * - `'operation'`  — named-op route. `name` is the operation key declared
 *                    in `EntityRouteConfig.operations`. `record` may be
 *                    `null` if the named op does not pre-fetch a record
 *                    before invoking policy.
 */
export type PolicyAction =
  | { kind: 'create' }
  | { kind: 'list' }
  | { kind: 'get' }
  | { kind: 'update' }
  | { kind: 'delete' }
  | { kind: 'operation'; name: string };

/**
 * The structured input passed to a policy resolver on every check.
 *
 * `TRecord` and `TInput` are the entity's record and create/update input
 * types. Framework default is `unknown` — consumers tighten the generics
 * in their own resolver code via `PolicyResolver<MyRecord, MyInput>`.
 *
 * @remarks
 * - `userId` is **non-null**: the framework only invokes policy after the
 *   auth step has succeeded. If `auth` is not `userAuth` or `bearer`,
 *   declaring `permission.policy` is a startup error (see the superRefine
 *   cross-field check).
 * - `tenantId` is `null` when the app is not multi-tenant; resolvers
 *   should tolerate `null`.
 * - `c` is the Hono `Context`. Resolvers MAY read request headers,
 *   metadata, or attach breadcrumbs via `c.set('policyTrace', ...)`.
 *   Resolvers MUST NOT mutate `c.req` or write response bodies — returning
 *   a decision is the only allowed side effect.
 */
export interface PolicyInput<TRecord = unknown, TInput = unknown> {
  /** The discriminated action being authorized. */
  action: PolicyAction;
  /** The authenticated user ID. Guaranteed non-null. */
  userId: string;
  /** Tenant ID from context, or `null` if the app is single-tenant. */
  tenantId: string | null;
  /**
   * The fetched record. Present for `get`, `update`, `delete`, and some
   * named ops. `null` for `create`, `list`, and named ops that do not
   * pre-fetch.
   */
  record: TRecord | null;
  /**
   * The request payload. Present for `create` and `update`. `null` for
   * read-only ops.
   */
  input: TInput | null;
  /** Raw Hono context. Read-only from the resolver's perspective. */
  c: import('hono').Context;
}

/**
 * The structured return value of a policy resolver.
 *
 * Resolvers may return a plain `boolean` for the simple allow/deny case;
 * the framework normalizes `true` → `{ allow: true }` and `false` →
 * `{ allow: false, status: 403 }`. Return a `PolicyDecision` explicitly
 * when you want to:
 *
 * - Surface a `reason` for audit logs (not leaked to the client body).
 * - Override the rejection status code to `404` for leak-prevention
 *   (when the existence of the record itself is sensitive).
 * - Attach a structured `metadata` blob for downstream middleware.
 *
 * @remarks
 * The HTTP response body on deny is always a generic
 * `{ error: 'forbidden' }` or `{ error: 'not found' }`. The `reason` field
 * is recorded server-side only — via event bus `entity:policy.denied` and
 * optional logger integration. Never echoed to the client.
 */
export interface PolicyDecision {
  allow: boolean;
  /** Audit-log-only reason. Not included in the HTTP response body. */
  reason?: string;
  /**
   * HTTP status on deny. Defaults to `403`. Set to `404` when the
   * existence of the record is itself sensitive (the caller should not
   * learn whether the row exists).
   */
  status?: 403 | 404;
  /** Optional metadata attached to the decision for downstream middleware. */
  metadata?: Record<string, unknown>;
}

/**
 * The resolver signature. Registered by consumer packages at `setupMiddleware`
 * and looked up by name at request time.
 *
 * Resolvers must be pure in the HTTP sense: they may read from databases,
 * caches, or other services, but they must NOT write to the response,
 * throw to terminate the request (return `false` or
 * `{ allow: false }` instead), or mutate the request.
 */
export type PolicyResolver<TRecord = unknown, TInput = unknown> = (
  input: PolicyInput<TRecord, TInput>,
) => Promise<boolean | PolicyDecision>;

/**
 * Declarative reference to a policy resolver.
 *
 * The `resolver` field is an opaque string key looked up against the
 * policy registry on the `SlingshotContext` at `setupRoutes` time.
 * Registering a resolver under this key is the consumer package's
 * responsibility; failing to register is a **startup error**, not a
 * request-time error.
 *
 * @example
 * ```jsonc
 * "permission": {
 *   "policy": {
 *     "resolver": "polls:sourcePolicy",
 *     "applyTo": ["get", "update", "delete", "operation:closePoll", "operation:results"]
 *   }
 * }
 * ```
 */
export interface EntityRoutePolicyConfig {
  /**
   * Resolver key. Opaque to the framework. Must be registered via
   * `registerEntityPolicy(app, key, resolver)` during the consumer
   * plugin's `setupMiddleware` phase.
   */
  resolver: string;
  /**
   * Restrict the policy to a subset of operations. Each entry is either
   * a CRUD action (`'create' | 'list' | 'get' | 'update' | 'delete'`) or
   * a named op in the form `'operation:<opName>'`.
   *
   * Defaults to **all operations** — CRUD and every named op declared on
   * the entity.
   */
  applyTo?: readonly string[];
  /**
   * On deny, return `404` instead of the default `403`. Use when the
   * existence of the record is itself sensitive and should not leak.
   * Individual resolver calls can still override this via
   * `PolicyDecision.status`.
   */
  leakSafe?: boolean;
}

// --- Permissions ---
/**
 * Permission check applied to a route operation.
 *
 * The framework's permission evaluator checks whether the authenticated subject holds a
 * grant for `requires` within the resolved scope. The check runs after the auth middleware
 * has established the request identity and before the route handler is called.
 *
 * @remarks
 * `ownerField` enables resource-ownership bypass: if the entity record's `ownerField`
 * matches the authenticated user ID, the permission check is skipped and access is granted.
 * `or` provides an additive alternative action — the request is allowed if the subject
 * holds either `requires` **or** `or`.
 * `scope` adds extra key/value pairs to the permission scope resolution context, allowing
 * multi-tenant checks (e.g., scoping a grant to a specific `tenantId`).
 *
 * @example
 * ```ts
 * const permission: RoutePermissionConfig = {
 *   requires: 'post:write',
 *   ownerField: 'authorId',   // the post author can always write their own post
 *   or: 'post:moderate',      // moderators can also write any post
 *   scope: { tenantId: ':tenantId' }, // scope the grant to the request's tenantId param
 * };
 * ```
 */
export interface RoutePermissionConfig {
  /** The permission action that must be granted (e.g. `'post:write'`). */
  requires: string;

  /**
   * Entity field whose value is compared to the authenticated user ID for ownership checks.
   *
   * @remarks
   * When set, the framework fetches the entity record from the request path param (typically
   * `:id`) and reads `entityRecord[ownerField]`. If it equals the authenticated user's ID,
   * the permission check is bypassed and access is granted unconditionally. This enables
   * resource-ownership patterns (e.g., a post author can always edit their own post) without
   * an explicit grant.
   *
   * `ownerField` must be a `'string'` field on the entity. If the entity record is not found
   * (already deleted or bad ID), the ownership check returns `false` and `requires` must be
   * satisfied instead. Omit when the operation is not resource-scoped (e.g. `list`).
   */
  ownerField?: string;

  /**
   * An alternative permission action that also grants access (`requires` OR `or`).
   *
   * @remarks
   * Access is granted when the subject holds `requires` **or** `or` — either is independently
   * sufficient. There is no AND semantics. A common pattern is combining a narrow action with
   * an admin-level override: `requires: 'post:write'` + `or: 'post:moderate'`.
   */
  or?: string;

  /**
   * Additional scope key/value pairs injected into the permission scope resolution context.
   *
   * @remarks
   * Values are resolved at permission-check time using a prefix-based dispatch:
   *
   * - **`param:field`** — URL path parameter via `c.req.param()`.
   *   Use for routes where the scoped value is in the URL (e.g. `PATCH /:id`).
   *
   * - **`body:field`** — Parsed JSON request body field.
   *   Use for POST create routes where the scoped value is in the payload.
   *   Supports dot-path traversal (e.g. `body:metadata.orgId`).
   *   Returns 400 if the request body cannot be parsed as JSON.
   *
   * - **`record:field`** — Field from the entity record loaded by `:id`.
   *   Use for PATCH/DELETE/GET-by-id routes where the scoped value lives on the
   *   entity being mutated. The entity is loaded once and cached for the request.
   *   Supports dot-path traversal. Returns 404 if the entity record is not found.
   *
   * - **(no prefix)** — Literal static string value.
   *
   * Prefixes can be mixed freely within a single scope object.
   *
   * @example
   * ```ts
   * // POST create — scope from request body
   * create: {
   *   permission: {
   *     requires: 'chat:room.write',
   *     scope: { resourceType: 'chat:room', resourceId: 'body:roomId' },
   *   },
   * }
   *
   * // PATCH update — scope from the entity record's foreign key
   * update: {
   *   permission: {
   *     requires: 'chat:room.manage',
   *     scope: { resourceType: 'chat:room', resourceId: 'record:roomId' },
   *   },
   * }
   *
   * // DELETE — scope from URL param (entity's own ID)
   * delete: {
   *   permission: {
   *     requires: 'chat:room.delete',
   *     scope: { resourceType: 'chat:room', resourceId: 'param:id' },
   *   },
   * }
   * ```
   */
  scope?: Record<string, string>;

  /**
   * Policy resolver for cross-entity or relational access control.
   *
   * Runs **after** `dataScope` narrowing and **after** `parentAuth` /
   * `ownerField` checks. Use when the answer to "can this user do this?"
   * requires data owned by a different package, dispatch on a
   * discriminator field, or business logic that cannot be expressed as a
   * field-equals-value filter.
   *
   * Declaring `policy` without registering a resolver under the key is a
   * startup error — `setupRoutes` throws.
   *
   * @see {@link EntityRoutePolicyConfig}
   */
  policy?: EntityRoutePolicyConfig;

  /**
   * Cross-entity parent authorization check.
   *
   * When set, the framework fetches the parent entity record (using `RouteConfigDeps.parentAdapter`)
   * before evaluating the regular permission check. If the parent record does not exist or its
   * `tenantField` value does not match the request's `tenantId` context value, the request is
   * rejected with **404** (not 403 — to avoid leaking whether the parent exists).
   *
   * This is the config-driven equivalent of the manual pattern:
   * ```ts
   * const doc = await documentAdapter.get({ id: docId });
   * if (!doc || doc.orgId !== orgId) return c.json({ error: 'Not found' }, 404);
   * ```
   *
   * The `parentAdapter` must be provided via `RouteConfigDeps.parentAdapter` (or
   * `EntityPluginEntry.buildParentAdapter`). The check fires independently of any permission
   * evaluator — a route can use `parentAuth` without a full permissions system.
   *
   * @example
   * ```ts
   * list: {
   *   auth: 'userAuth',
   *   permission: {
   *     requires: 'content:snapshot.read',
   *     parentAuth: { idParam: 'id', tenantField: 'orgId' },
   *   },
   * }
   * // Used with EntityPluginEntry: parentPath: '/documents/:id', routePath: 'versions'
   * ```
   */
  parentAuth?: {
    /**
     * URL path parameter whose value is the parent entity's ID.
     * For `/documents/:id/versions`, this is `'id'`.
     */
    idParam: string;
    /**
     * Field on the parent record to compare against the request's `tenantId` context value.
     * For example, `'orgId'` checks that `parentRecord.orgId === c.get('tenantId')`.
     */
    tenantField: string;
  };
}

// --- Rate Limiting ---
/**
 * Per-route rate limit configuration applied by the framework's rate-limit middleware.
 *
 * The framework derives the rate-limit key from the authenticated user ID when auth is
 * enabled, or from the request IP address for public routes. Counters are stored in the
 * configured cache store and reset after each `windowMs` rolling window.
 *
 * @remarks
 * Rate limits are applied per operation — set a tighter limit on `create` or `delete`
 * while leaving `list` unrestricted. Both `windowMs` and `max` must be positive integers.
 *
 * @example
 * ```ts
 * const rateLimit: RouteRateLimitConfig = {
 *   windowMs: 60_000, // 1 minute rolling window
 *   max: 10,          // at most 10 requests per user per minute
 * };
 * ```
 */
export interface RouteRateLimitConfig {
  /**
   * Rolling window duration in milliseconds. Must be a positive integer.
   *
   * @remarks
   * The window is **rolling**, not fixed-bucket — each request resets the window for that
   * key. Common values: `60_000` (1 minute), `3_600_000` (1 hour).
   */
  windowMs: number;

  /**
   * Maximum number of requests allowed per rate-limit key per window. Must be a positive integer.
   *
   * @remarks
   * The rate-limit key is the authenticated user ID for auth-protected routes, or the client
   * IP address for public routes (`auth: 'none'`). When this limit is exceeded the framework
   * returns HTTP 429 with a `Retry-After` header computed from the remaining window time.
   */
  max: number;
}

// --- Idempotency ---
/**
 * Scope used when deriving the server-side storage key for entity route idempotency.
 *
 * The final key always includes the entity name, operation name, and client-supplied
 * `Idempotency-Key`. `scope` controls which request identity dimension is added on top.
 */
export type RouteIdempotencyScope = 'user' | 'tenant' | 'global';

/**
 * Idempotency configuration for a single entity operation.
 *
 * When enabled, the framework stores the first successful JSON response under a derived
 * server-side key and replays it on later retries that present the same
 * `Idempotency-Key` header. Reusing the same key with a different request fingerprint is
 * rejected with HTTP 409.
 */
export interface RouteIdempotencyConfig {
  /**
   * Retention period for cached idempotency records, in seconds.
   *
   * Defaults to `86400` (24 hours).
   */
  ttl?: number;

  /**
   * Identity dimension included in the derived storage key.
   *
   * - `'user'`   — scope by authenticated user ID. Default.
   * - `'tenant'` — scope by tenant ID (or `'none'` when no tenant is resolved).
   * - `'global'` — no extra identity dimension beyond entity + operation.
   */
  scope?: RouteIdempotencyScope;
}

// --- Events ---
/**
 * Event emitted on the `SlingshotEventBus` after a route operation completes successfully.
 *
 * Can be supplied as a plain string shorthand (just the event key) or as a full object
 * when you need to control the payload fields or include framework context fields.
 * The event is never emitted if the route handler returns an error response.
 *
 * @remarks
 * Event keys that use a forbidden namespace (`security.`, `auth:`, `community:delivery.`,
 * `push:`, `app:`) are rejected at validation time. To stream an event to browser clients
 * via SSE, also register the key in `EntityRouteConfig.clientSafeEvents`.
 * `payload` defaults to including all entity fields when omitted — specify an explicit list
 * to limit the data surface exposed to event consumers.
 *
 * @example
 * ```ts
 * // Shorthand (event key only)
 * const event = 'post:post.created';
 *
 * // Full config with selective payload
 * const event: RouteEventConfig = {
 *   key: 'post:post.created',
 *   payload: ['id', 'title', 'authorId'],
 *   include: ['tenantId', 'actorId'],
 * };
 * ```
 */
export interface RouteEventConfig {
  /**
   * The event key to emit on the `SlingshotEventBus` after the operation succeeds.
   *
   * @remarks
   * Must follow the format `namespace:storageName.action` (e.g. `'post:post.created'`).
   * Forbidden namespaces (`security.*`, `auth:*`, `community:delivery.*`, `push:*`, `app:*`)
   * are rejected at validation time — do not use them here.
   *
   * To stream this event to browser clients via SSE, also add the key to
   * `EntityRouteConfig.clientSafeEvents`. The event is never emitted when the route
   * handler returns an error response.
   */
  key: string;

  /**
   * Entity field names to include in the event payload.
   *
   * @remarks
   * Omit to include all entity fields in the payload. Specify an explicit list to limit the
   * data surface exposed to event consumers — useful when some fields are sensitive (e.g.
   * hashed passwords, internal flags) and should not leak to bus subscribers.
   *
   * Field names must exist on the entity; invalid names are caught at startup validation.
   */
  payload?: string[];

  /**
   * Framework-level context fields to inject alongside entity fields in the event payload.
   *
   * @remarks
   * - `'tenantId'` — the resolved tenant ID for the request (from the tenant middleware).
   * - `'actorId'`  — the authenticated user ID that triggered the operation.
   * - `'requestId'` — the trace/correlation ID for the originating HTTP request.
   * - `'ip'`       — the client IP address (subject to `trustProxy` configuration).
   *
   * These context fields are injected by the framework at emit time and do not need to be
   * present on the entity itself. Omit `include` when downstream consumers don't need
   * audit/trace context in the event payload.
   */
  include?: ('tenantId' | 'actorId' | 'requestId' | 'ip')[];
}

// --- Per-Operation Config ---
/**
 * Configuration applied to a single CRUD operation or named custom operation.
 *
 * Used as the value type for the standard CRUD fields (`create`, `get`, `list`, `update`,
 * `delete`) and for entries in `EntityRouteConfig.operations`. All fields are optional —
 * unset fields fall through to `EntityRouteConfig.defaults`.
 *
 * @remarks
 * Merge precedence: specific operation config fields override `defaults` fields.
 * Use {@link resolveOpConfig} to obtain the merged result for a given operation name.
 * `middleware` entries are resolved by name from the entity plugin config's middleware
 * registry — referencing an unknown name is a startup-time error.
 *
 * @example
 * ```ts
 * const createOp: RouteOperationConfig = {
 *   auth: 'userAuth',
 *   permission: { requires: 'post:write' },
 *   rateLimit: { windowMs: 60_000, max: 5 },
 *   event: 'post:post.created',
 *   middleware: ['auditLog'],
 * };
 * ```
 */
export interface RouteOperationConfig {
  /**
   * Auth strategy for this operation. Overrides `defaults.auth` when set.
   *
   * @remarks
   * Merge precedence: a value set here overrides the matching key in `EntityRouteConfig.defaults`.
   * If omitted on both the operation config and `defaults`, no auth middleware is wired for
   * this operation (equivalent to `'none'`).
   */
  auth?: RouteAuthConfig;

  /**
   * Permission check applied after auth for this operation.
   *
   * @remarks
   * Evaluated after the auth middleware has established the request identity. If `auth` is
   * `'none'` and `permission` is set, the permission check runs but has no authenticated
   * subject to check against — it will always fail. Only set `permission` when `auth` is
   * also set (or inherited from `defaults`).
   */
  permission?: RoutePermissionConfig;

  /**
   * Rate limit applied to this operation.
   *
   * @remarks
   * Applied independently per operation — a tight limit on `create` does not affect `list`.
   * The limit key is the authenticated user ID when auth is enabled, or the client IP for
   * public operations. Overrides `defaults.rateLimit` when set.
   */
  rateLimit?: RouteRateLimitConfig;

  /**
   * Event emitted on the `SlingshotEventBus` after this operation succeeds.
   *
   * @remarks
   * Accepts either a plain string shorthand (event key only, all entity fields in payload)
   * or a full `RouteEventConfig` object for selective payload and context field inclusion.
   * The event is never emitted when the handler returns an error response (4xx/5xx).
   */
  event?: RouteEventConfig | string;

  /**
   * Named middleware factory keys to apply to this operation's route, in declaration order.
   *
   * @remarks
   * Keys must exist in `EntityRouteConfig.middleware` — referencing an unknown name is a
   * startup-time error. Middleware runs after auth/permission but before the operation
   * handler. Each factory is resolved from the entity plugin config's `middleware` map at
   * startup, not at request time.
   */
  middleware?: string[];

  /**
   * Idempotency handling for retried requests to this operation.
   *
   * When enabled, the framework requires clients to supply `Idempotency-Key` and replays
   * the first successful response for later retries of the same logical request.
   */
  idempotency?: boolean | RouteIdempotencyConfig;
}

/**
 * HTTP methods available as overrides for named (non-CRUD) entity operations.
 *
 * CRUD operations (`create`, `list`, `get`, `update`, `delete`) ignore this —
 * their HTTP methods are semantically fixed by the operation type.
 */
export type NamedOpHttpMethod = 'get' | 'head' | 'post' | 'put' | 'patch' | 'delete';

/**
 * Route configuration for a named (non-CRUD) entity operation.
 *
 * Extends `RouteOperationConfig` with `method` — an optional HTTP method override.
 * Named operations default by operation kind:
 * - `lookup` → `GET`
 * - `exists` → `HEAD`
 * - `custom` → `http.method` when declared on the operation
 * - everything else → `POST`
 *
 * @example
 * ```ts
 * routes: {
 *   operations: {
 *     listByDocument: { method: 'get', permission: { requires: 'myapp:item.read' } },
 *   },
 * }
 * ```
 */
export interface RouteNamedOperationConfig extends RouteOperationConfig {
  /**
   * HTTP method for this named operation. When omitted, the runtime infers a default
   * from the operation kind (`lookup` → `'get'`, `exists` → `'head'`, otherwise `'post'`
   * unless a custom op declares `http.method`).
   *
   * @remarks
   * Only applies to entries in `EntityRouteConfig.operations`. The standard CRUD fields
   * (`create`, `list`, `get`, `update`, `delete`) ignore this field — their HTTP methods
   * are semantically fixed (`POST`, `GET /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`
   * respectively) and cannot be overridden here.
   *
   * Use `'get'` for read-only query operations (e.g. `listByCategory`, `search`) so they
   * align with REST semantics and allow browser caching. Use `'head'` for existence checks,
   * `'post'` for state-mutating operations, and `'put'` for idempotent full-replacement
   * operations.
   *
   * @example
   * ```ts
   * routes: {
   *   operations: {
   *     publish:        { method: 'post',  permission: { requires: 'post:write' } },
   *     listByCategory: { method: 'get',   permission: { requires: 'post:read' } },
   *     replace:        { method: 'put',   auth: 'userAuth' },
   *   },
   * }
   * ```
   */
  method?: NamedOpHttpMethod;

  /**
   * URL path segment override for this named operation.
   *
   * @remarks
   * Required when the operation uses `op.custom({ http: { path: '...' } })` to
   * register its route handler on a non-default path. When set, middleware
   * (auth, permissions, rate-limiting) is registered on
   * `/{entity}/{path}` instead of the default `/{entity}/{kebab-op-name}`.
   *
   * Must exactly match the path used in `op.custom({ http: { path } })` so
   * that auth middleware fires on the correct route.
   *
   * @example
   * ```ts
   * routes: {
   *   operations: {
   *     forwardMessage: { auth: 'userAuth', path: 'forward' },
   *   },
   * }
   * ```
   */
  path?: string;
}

// --- Webhooks ---
/**
 * Outbound webhook configuration for a named webhook trigger.
 *
 * Named webhooks are declared in `EntityRouteConfig.webhooks` and fired by the framework
 * after a route operation succeeds. The webhook key corresponds to a registered webhook
 * handler in the app's webhook registry.
 *
 * @remarks
 * Omitting `payload` sends all entity fields to the webhook target. Specify an explicit
 * list to limit the data surface, especially for webhooks that cross trust boundaries.
 *
 * @example
 * ```ts
 * const webhooks: Record<string, RouteWebhookConfig> = {
 *   onPostCreated: { payload: ['id', 'title', 'authorId'] },
 * };
 * ```
 */
export interface RouteWebhookConfig {
  /** Entity fields to include in the webhook payload. Omit to include all fields. */
  payload?: string[];
}

// --- Retention ---
/**
 * Data retention policy for hard-deleting soft-deleted records after a grace period.
 *
 * When configured, the framework schedules a background job that periodically queries for
 * soft-deleted records that are older than `after` and match the `when` conditions, then
 * permanently removes them from the backing store.
 *
 * @remarks
 * This config is only meaningful for entities that use a soft-delete pattern (i.e., records
 * are marked deleted rather than physically removed). The `after` duration uses the format
 * `{positive integer}{unit}` where unit is one of `s` (seconds), `m` (minutes), `h` (hours),
 * `d` (days), `w` (weeks), or `y` (years).
 * The `when` filter is evaluated against the stored entity record fields using the same
 * filter expression syntax as list operations.
 *
 * @example
 * ```ts
 * const retention: RouteRetentionConfig = {
 *   hardDelete: {
 *     after: '90d',                     // hard-delete 90 days after soft deletion
 *     when: { status: 'deleted' },      // only records explicitly in 'deleted' status
 *   },
 * };
 * ```
 */
export interface RouteRetentionConfig {
  hardDelete?: {
    /**
     * Duration after soft deletion before the hard delete runs.
     * Format: positive integer + unit suffix (e.g. `'90d'`, `'1y'`, `'30m'`).
     */
    after: string;
    /** Conditions the record must match to be eligible for hard deletion. */
    when: Record<string, unknown>;
  };
}

// --- Permission Resource Type ---
/**
 * Declares the permission resource type and role/action mappings for an entity.
 *
 * When present on `EntityRouteConfig.permissions`, the framework auto-registers this
 * resource type in the `PermissionRegistry` at startup, making all declared `actions`
 * available for grant assignment and role-based default wiring.
 *
 * @remarks
 * `scopeField` gates grants to a specific field value — for example, setting
 * `scopeField: 'tenantId'` means grants are scoped per tenant rather than globally.
 * `roles` provides default role → actions mappings that the framework seeds into the
 * permission store on first run. Use `'*'` as the sole entry in an actions array to
 * grant all declared actions to that role.
 * At least one entry in `actions` is required (enforced by the schema).
 *
 * @example
 * ```ts
 * const permissions: EntityPermissionConfig = {
 *   resourceType: 'post',
 *   scopeField: 'tenantId',
 *   actions: ['post:read', 'post:write', 'post:delete', 'post:moderate'],
 *   roles: {
 *     viewer:    ['post:read'],
 *     editor:    ['post:read', 'post:write'],
 *     moderator: ['post:read', 'post:write', 'post:moderate'],
 *     admin:     ['*'],
 *   },
 * };
 * ```
 */
export interface EntityPermissionConfig {
  /**
   * The resource type string registered in the `PermissionRegistry`.
   *
   * @remarks
   * Used as the resource type key when evaluating `requires` actions (e.g. `'post'` for
   * `'post:write'`). Must be unique across all entities in the application — duplicate
   * `resourceType` values result in a startup-time registration error.
   */
  resourceType: string;

  /**
   * Entity field used to scope grants to a specific field value.
   *
   * @remarks
   * When set (e.g. `'tenantId'`), grants for this resource type are automatically scoped
   * per tenant rather than globally. A user granted `post:write` for `tenantId: 'acme'`
   * cannot write posts for `tenantId: 'widgets'`. Leave unset for single-tenant or
   * globally-scoped resources.
   */
  scopeField?: string;

  /**
   * All actions that can be granted on this resource type. Must contain at least one entry.
   *
   * @remarks
   * The framework auto-registers these with the `PermissionRegistry` at startup. Use the
   * `namespace:resource.action` convention (e.g. `'post:post.read'`, `'post:post.write'`).
   * The `roles` map can reference `'*'` as a shorthand for all declared actions.
   */
  actions: string[];

  /**
   * Default role → actions mapping seeded into the permission store on first run.
   *
   * @remarks
   * The framework seeds these defaults when the permission store is empty for this resource
   * type. Use `'*'` as the sole entry in an actions array to grant all `actions` declared
   * above to that role (e.g. `admin: ['*']`). Role names are application-defined strings
   * (e.g. `'viewer'`, `'editor'`, `'admin'`) — there is no global role registry.
   *
   * Defaults are applied only on first run (when no grants exist for this resource type).
   * Subsequent deploys that change `roles` do not overwrite existing stored grants.
   */
  roles?: Record<string, string[] | ['*']>;
}

// --- Data Scope ---
/**
 * Source prefix for an {@link EntityRouteDataScopeConfig.from} binding.
 *
 * - `'ctx:'` reads from a Hono context variable (for example, `'ctx:authUserId'` reads
 *   `c.get('authUserId')`).
 * - `'param:'` reads from a URL path parameter (for example, `'param:orgId'` reads
 *   `c.req.param('orgId')`).
 *
 * `body:` and `record:` prefixes are intentionally not supported because scope sources must
 * be server-side values, not client-supplied payload data or self-referential record values.
 */
export type EntityRouteDataScopeSource = `ctx:${string}` | `param:${string}`;

/**
 * CRUD operations that a {@link EntityRouteDataScopeConfig} entry can target.
 *
 * @remarks
 * Omit {@link EntityRouteDataScopeConfig.applyTo} to apply an entry to all five CRUD routes.
 * Named operations are not part of this union and are never subject to `dataScope`.
 */
export type EntityDataScopedCrudOp = 'list' | 'get' | 'create' | 'update' | 'delete';

/**
 * Declarative row-level isolation for standard CRUD routes.
 *
 * @remarks
 * Each entry binds a server-side source value to an entity field and enforces that binding
 * on the selected CRUD operations. `create` writes the scoped field from the resolved source,
 * `list` merges the binding into the adapter filter, and `get` / `update` / `delete` apply the
 * binding atomically as an additional adapter filter. A mismatch returns 404, not 403.
 *
 * If an update request body contains any scoped field, the request is rejected with HTTP 400
 * and `{ error: 'scoped_field_immutable', field }`.
 *
 * Multiple entries may be supplied as an array and are enforced with AND semantics. A
 * `dataScope` declaration without any auth-enabled route is rejected at startup by the Zod
 * schema.
 */
export interface EntityRouteDataScopeConfig {
  /**
   * The entity field to scope by.
   *
   * @remarks
   * Must reference a declared entity field. Startup validation rejects unknown field names.
   */
  field: string;

  /**
   * The source expression used to resolve the scope value.
   *
   * @remarks
   * Supports `ctx:<name>` and `param:<name>` sources.
   */
  from: EntityRouteDataScopeSource;

  /**
   * CRUD operations to enforce this scope on.
   *
   * @remarks
   * Omit to apply to every CRUD route. Named operations are never included here.
   */
  applyTo?: readonly EntityDataScopedCrudOp[];
}

// --- Custom Middleware Registration ---
/**
 * Named middleware factory registry for an entity's routes.
 *
 * Declares which middleware factories are available for this entity's operations.
 * Keys are the middleware names referenced in `RouteOperationConfig.middleware` and
 * `EntityChannelDeclaration.middleware`. Values are always `true` — the actual factory
 * functions are resolved from the entity plugin config's `middleware` map at startup,
 * not stored here.
 *
 * @remarks
 * This interface serves as a declaration manifest: it tells the framework (and TypeScript)
 * which middleware names are valid for this entity. The concrete factory implementations
 * live in the plugin config, keeping config serializable and free of function references.
 * Referencing a name in `RouteOperationConfig.middleware` that is absent from this registry
 * is a startup-time error.
 *
 * @example
 * ```ts
 * const middleware: RouteMiddlewareConfig = {
 *   auditLog: true,
 *   rateLimitSubscribe: true,
 * };
 * ```
 */
export interface RouteMiddlewareConfig {
  [name: string]: true;
}

// --- Cascade Event Handlers ---
/**
 * A declarative cascade that batch-updates or batch-deletes related entity records
 * when a specified bus event fires.
 *
 * Common use-case: when an organisation is deleted, cascade-delete all of its posts
 * without writing an explicit event handler in every affected plugin.
 *
 * @remarks
 * The cascade runs asynchronously after the triggering event is emitted. It uses the same
 * backing store as the entity's configured repository — no cross-store operations are
 * supported. For `action: 'update'`, `set` must be provided; the framework will throw at
 * startup if `set` is absent on an update cascade.
 * `filter` uses the same filter expression syntax as list operations, supporting field
 * equality checks and basic comparators against the entity's stored fields.
 *
 * @example
 * ```ts
 * // Cascade-delete all posts when their owning organisation is deleted.
 * const cascade: RouteCascadeConfig = {
 *   event: 'org:org.deleted',
 *   batch: {
 *     action: 'delete',
 *     filter: { orgId: ':payload.id' }, // bind payload.id to the filter
 *   },
 * };
 *
 * // Cascade-update all posts to 'archived' when the author is suspended.
 * const archiveCascade: RouteCascadeConfig = {
 *   event: 'user:user.suspended',
 *   batch: {
 *     action: 'update',
 *     filter: { authorId: ':payload.id' },
 *     set: { status: 'archived' },
 *   },
 * };
 * ```
 */
export interface RouteCascadeConfig {
  /** The bus event key that triggers the cascade. */
  event: string;
  batch: {
    /** Whether to update or delete the matched records. */
    action: 'update' | 'delete';
    /** Filter expression for selecting the records to affect. */
    filter: Record<string, unknown>;
    /** Fields to set when `action` is `'update'`. Required when `action` is `'update'`. */
    set?: Record<string, unknown>;
  };
}

// --- Top-Level Entity Route Config ---
/**
 * Declarative route configuration for a single entity.
 *
 * Attached to an `EntityConfig` to configure auth, permissions, rate limits,
 * events, middleware, retention, and cascades for generated CRUD routes without
 * writing middleware by hand.
 *
 * @remarks
 * `defaults` applies to all operations unless overridden. Individual operation configs
 * (e.g., `create`, `list`) are merged on top of `defaults` — specific keys win.
 *
 * @example
 * ```ts
 * import { defineEntity, field } from '@lastshotlabs/slingshot-core';
 *
 * export const Post = defineEntity('Post', {
 *   fields: { id: field.string({ primary: true }), title: field.string() },
 *   routes: {
 *     defaults: { auth: 'userAuth' },
 *     list: { auth: 'none' }, // override: public list
 *     create: { permission: { requires: 'post:write' } },
 *   },
 * });
 * ```
 */
export interface EntityRouteConfig {
  /**
   * Config for the `POST /entity` create route.
   *
   * @remarks
   * Merged on top of `defaults`. Auth, permission, rate-limit, events, and middleware
   * defined here override the corresponding keys in `defaults`.
   */
  create?: RouteOperationConfig;

  /**
   * Config for the `GET /entity/:id` get-by-ID route.
   *
   * @remarks
   * Merged on top of `defaults`. Override `auth` to `'none'` for public entity reads
   * while keeping other operations protected.
   */
  get?: RouteOperationConfig;

  /**
   * Config for the `GET /entity` list route.
   *
   * @remarks
   * Merged on top of `defaults`. Commonly set to `{ auth: 'none' }` when entities are
   * publicly browsable but writes require authentication.
   */
  list?: RouteOperationConfig;

  /**
   * Config for the `PATCH /entity/:id` partial-update route.
   *
   * @remarks
   * Merged on top of `defaults`. Use `ownerField` in `permission` to allow the resource
   * owner to update their own record without an explicit permission grant.
   */
  update?: RouteOperationConfig;

  /**
   * Config for the `DELETE /entity/:id` delete route.
   *
   * @remarks
   * Merged on top of `defaults`. Set a tighter `rateLimit` here than on `create` since
   * deletes are typically lower-frequency but higher-impact operations.
   */
  delete?: RouteOperationConfig;

  /**
   * Named custom operations beyond the standard CRUD set.
   *
   * @remarks
   * Each key becomes an additional route at `POST /entity/:key` (or the method specified
   * by `RouteNamedOperationConfig.method`). Keys are merged on top of `defaults` using the
   * same precedence rules as CRUD operations. Use `resolveOpConfig(routes, opName)` to get
   * the merged config for a given operation name at route-registration time.
   */
  operations?: Record<string, RouteNamedOperationConfig>;

  /**
   * Default config applied to all operations (merged, specific ops override).
   *
   * @remarks
   * Acts as a base layer — any key set in `defaults` is used for operations that don't
   * override that key themselves. Use this to set `auth: 'userAuth'` once rather than
   * repeating it on every operation, then selectively override individual operations
   * (e.g. `list: { auth: 'none' }`) as needed.
   */
  defaults?: RouteOperationConfig;

  /**
   * Route keys to exclude from generation.
   *
   * @remarks
   * Each entry is a route key string in the format `'METHOD /path'` (e.g.
   * `'DELETE /posts/:id'`). The route generator skips any generated route whose key
   * matches an entry here, allowing you to suppress specific CRUD routes without
   * disabling route generation entirely.
   */
  disable?: string[];

  /**
   * Bus event keys to register as client-safe for SSE streaming.
   *
   * @remarks
   * Registering a key here calls `bus.registerClientSafeEvents([...keys])` at startup.
   * Only registered keys are delivered to browser clients via the SSE endpoint — all
   * other keys are filtered out. This is the authoritative list; event keys referenced
   * in `RouteEventConfig` do not auto-register as client-safe.
   */
  clientSafeEvents?: string[];

  /** Named outbound webhook configs. */
  webhooks?: Record<string, RouteWebhookConfig>;

  /** Hard-delete retention policy for soft-deleted records. */
  retention?: RouteRetentionConfig;

  /** Resource type declaration for the permissions system. */
  permissions?: EntityPermissionConfig;

  /**
   * Declarative row-level isolation for standard CRUD routes.
   *
   * @remarks
   * Binds a server-side context value or URL path parameter to an entity field and enforces
   * that binding on the selected CRUD operations. See {@link EntityRouteDataScopeConfig} for
   * the full semantics.
   */
  dataScope?: EntityRouteDataScopeConfig | readonly EntityRouteDataScopeConfig[];

  /**
   * Named middleware factory declaration registry.
   *
   * @remarks
   * Declares which middleware names are valid for this entity's operations and channels.
   * Values are always `true` — the actual factory implementations live in the plugin config,
   * keeping this config serialisable and free of function references. The concrete factories
   * are resolved by name from the plugin config's `middleware` map at startup.
   */
  middleware?: RouteMiddlewareConfig;

  /** Cascade handlers that react to bus events and batch-modify related data. */
  cascades?: RouteCascadeConfig[];
}

/**
 * Merge operation-level defaults with the specific config for a named operation.
 *
 * Precedence: specific CRUD field (e.g. `routeConfig.create`) or named operation
 * (e.g. `routeConfig.operations.publish`) > `routeConfig.defaults`.
 *
 * @param routeConfig - The top-level entity route configuration.
 * @param opName - The operation name (`'create'`, `'list'`, `'delete'`, or a custom name).
 * @returns The merged `RouteOperationConfig`, or `undefined` if no operation-specific config
 *   exists and `defaults` is empty (so callers can skip middleware registration entirely).
 *
 * @example
 * ```ts
 * import { resolveOpConfig } from '@lastshotlabs/slingshot-core';
 *
 * const opConfig = resolveOpConfig(entity.routes, 'create');
 * if (opConfig?.auth === 'userAuth') router.use(path, auth.userAuth);
 * ```
 */
export function resolveOpConfig(
  routeConfig: EntityRouteConfig,
  opName: string,
): RouteOperationConfig | undefined {
  const defaults = routeConfig.defaults ?? {};
  const crud = routeConfig[opName as keyof EntityRouteConfig] as RouteOperationConfig | undefined;
  const named = routeConfig.operations?.[opName];
  const specific = crud ?? named;
  if (!specific && Object.keys(defaults).length === 0) return undefined;
  return { ...defaults, ...specific };
}
