import type { AuditLogProvider } from '../auditLog';
import type {
  CacheAdapter,
  CacheStoreName,
  EmailTemplate,
  FingerprintBuilder,
  RateLimitAdapter,
  RequestActorResolver,
  RouteAuthRegistry,
} from '../coreContracts';
import type { CronRegistryRepository } from '../cronRegistry';
import type { DataEncryptionKey } from '../crypto';
import type { SlingshotEventBus } from '../eventBus';
import type { SlingshotEvents } from '../eventPublisher';
import type { IdempotencyAdapter } from '../idempotencyAdapter';
import type { IdentityResolver } from '../identity';
import type { KafkaConnectorHandle } from '../kafkaConnectors';
import type { RuntimeSqliteDatabase } from '../runtime';
import type { SecretRepository } from '../secrets';
import type { SigningConfig } from '../signing';
import type { UploadRegistryRepository } from '../uploadRegistry';
import type { RoomPersistenceConfig, WsMessageDefaults, WsMessageRepository } from '../wsMessages';
import type { ResolvedStores } from './frameworkConfig';

// ---------------------------------------------------------------------------
// Persistence — resolved storage repositories, instance-scoped
// ---------------------------------------------------------------------------

/**
 * Resolved persistence repositories for the application instance.
 *
 * Created by `resolveFrameworkPersistence()` during server bootstrap and wired into
 * `SlingshotContext` by `createApp()`. All repositories are instance-scoped — no
 * shared module-level state across app instances.
 *
 * @remarks
 * Access these repositories via `ctx.persistence.*` in plugin `setupPost` hooks
 * and in framework middleware. Never access them before `createApp()` completes.
 */
export interface ResolvedPersistence {
  /**
   * Repository for tracking in-progress and completed file uploads.
   *
   * @remarks
   * Used by the uploads plugin to persist upload metadata (status, size, MIME type, path)
   * across requests. Resolved to the backing store configured for the uploads plugin at startup.
   */
  readonly uploadRegistry: UploadRegistryRepository;

  /**
   * Adapter for idempotency key storage.
   *
   * @remarks
   * Used by the idempotency middleware to record request fingerprints and cached responses,
   * preventing duplicate mutations from retried requests. Keys expire after the configured TTL.
   */
  readonly idempotency: IdempotencyAdapter;

  /**
   * Repository for persisting and replaying WebSocket room messages.
   *
   * @remarks
   * Used when WebSocket endpoints are configured with message persistence. Allows clients that
   * reconnect after a brief disconnect to replay missed messages via the recovery flow.
   */
  readonly wsMessages: WsMessageRepository;

  /**
   * Provider for writing and querying structured audit log entries.
   *
   * @remarks
   * Used by the audit middleware and route hooks to record who did what and when. The
   * concrete implementation is resolved from the audit log provider registry at startup.
   */
  readonly auditLog: AuditLogProvider;

  /**
   * Repository for persisting BullMQ scheduler names across deployments.
   *
   * @remarks
   * Used during server startup to detect and clean up stale schedulers left behind by
   * previous deployments. Without this registry, renamed or removed cron jobs would
   * continue running until the BullMQ queue is manually cleared.
   */
  readonly cronRegistry: CronRegistryRepository;

  /**
   * Configure per-room message persistence settings for a WebSocket endpoint.
   *
   * @param endpoint - The WebSocket endpoint key (e.g. `'chat'`).
   * @param room - The room name within the endpoint.
   * @param options - Max message count and TTL for this room.
   */
  configureRoom(endpoint: string, room: string, options: RoomPersistenceConfig): void;

  /**
   * Get the resolved persistence config for a specific (endpoint, room) pair.
   *
   * @param endpoint - The WebSocket endpoint key.
   * @param room - The room name within the endpoint.
   * @returns The resolved `{ maxCount, ttlSeconds }` config, or `null` if the room has no
   *   explicit config (callers should fall back to the defaults set via `setDefaults`).
   */
  getRoomConfig(endpoint: string, room: string): { maxCount: number; ttlSeconds: number } | null;

  /**
   * Set the default `maxCount` and `ttlSeconds` applied to rooms with no explicit config.
   *
   * @param defaults - Default message persistence settings for unconfigured rooms.
   */
  setDefaults(defaults: WsMessageDefaults): void;
}

// ---------------------------------------------------------------------------
// WebSocket state types
// ---------------------------------------------------------------------------

/**
 * Cross-instance WebSocket transport adapter.
 *
 * Used by the framework to fan out WS messages across multiple server instances
 * in a distributed deployment (e.g., via Redis Pub/Sub). A `null` handle means
 * single-instance deployment with no cross-instance delivery.
 *
 * @remarks
 * Defined here (not in framework internals) so `SlingshotContext` can reference it
 * without a circular dependency on the framework's transport layer.
 */
export interface WsTransportHandle {
  publish(endpoint: string, room: string, message: string, origin: string): Promise<void>;
  connect(
    onMessage: (endpoint: string, room: string, message: string, origin: string) => void,
  ): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Per-connection WebSocket message rate limit configuration.
 * Consumed by the framework to enforce a rolling message window per socket.
 */
export interface WsRateLimitConfig {
  /** Rolling window duration in milliseconds. */
  windowMs: number;
  /** Maximum messages per socket per window. */
  maxMessages: number;
  /**
   * 'drop'  — silently discard the message (default).
   * 'close' — close the connection with WebSocket code 1008 (Policy Violation).
   */
  onExceeded?: 'drop' | 'close';
}

/**
 * WebSocket connection state recovery configuration.
 * When set on an endpoint, sessions are held after disconnect so the
 * client can reconnect and resume within the configured window.
 */
export interface WsRecoveryConfig {
  /**
   * How long to hold a session after disconnect before expiring it.
   * Client must reconnect and send 'recover' within this window.
   * Default: 120_000 ms (2 minutes).
   */
  windowMs?: number;
}

/**
 * Rolling-window message rate limit bucket for a single WebSocket connection.
 *
 * Tracks the count of messages received in the current window. When `count` exceeds
 * the configured `maxMessages`, the connection is throttled (dropped or closed).
 */
export interface WsRateLimitBucket {
  /**
   * Messages received in the current rolling window.
   *
   * @remarks
   * Incremented on each inbound message. When `count` exceeds the configured `maxMessages`,
   * the framework applies the `onExceeded` policy (drop or close). Reset to `0` when a new
   * window starts (i.e. when `Date.now() - windowStart >= windowMs`).
   */
  count: number;

  /**
   * Epoch milliseconds when the current window started.
   *
   * @remarks
   * The window is reset when the next message arrives after `windowMs` has elapsed since
   * `windowStart`. This is a rolling window — not a fixed-bucket interval timer.
   */
  windowStart: number;
}

/**
 * Disconnected WebSocket session entry held for the recovery window.
 *
 * When a client disconnects unexpectedly, the session is retained in
 * `WsState.sessionRegistry` until `expiresAt` so the client can reconnect
 * and resume from `lastEventId` without missing messages.
 */
export interface WsSessionEntry {
  /**
   * Room keys the socket was subscribed to at disconnect time.
   *
   * @remarks
   * Used during reconnection to automatically re-subscribe the client to its previous rooms
   * without requiring the client to re-send subscribe messages. Room keys follow the format
   * `{storageName}:{entityId}:{channelName}`.
   */
  rooms: string[];

  /**
   * ID of the last message successfully delivered to this socket before disconnect.
   *
   * @remarks
   * Provided by the client in a `recover` message after reconnecting. The server uses this
   * cursor to replay messages from `wsMessages` that were delivered after `lastEventId`,
   * ensuring no events are missed during the disconnect window.
   */
  lastEventId: string;

  /**
   * Epoch milliseconds when this session entry expires and is eligible for cleanup.
   *
   * @remarks
   * Set to `Date.now() + WsRecoveryConfig.windowMs` at disconnect time. If the client
   * does not reconnect before `expiresAt`, the session entry is removed and the client
   * must start a fresh session (no missed-message recovery available).
   */
  expiresAt: number;
}

/**
 * Instance-scoped WebSocket runtime state container.
 *
 * Populated by `createServer()` after the Bun server is started.
 * `null` on the context when the application has no WebSocket endpoints configured.
 *
 * @remarks
 * The socket registry uses `unknown` types to prevent `slingshot-core` from importing Bun types.
 * Cast to `ServerWebSocket<SocketData>` at use sites in the framework layer.
 */
export interface WsState {
  /**
   * The Bun `Server` instance that owns the WebSocket upgrade.
   *
   * @remarks
   * Set by `createServer()` after the Bun server starts. `null` until then.
   * Typed `unknown` to prevent `slingshot-core` from importing Bun types directly.
   * Cast to `import(‘bun’).Server` at use sites in framework code.
   */
  server: unknown;

  /**
   * Cross-instance pub/sub transport adapter, or `null` for single-instance deployments.
   *
   * @remarks
   * When non-null, the framework uses this to fan out WS messages to sockets connected
   * to other server instances (e.g. in a horizontally-scaled deployment). Set during
   * `createServer()` after the transport is initialised.
   */
  transport: WsTransportHandle | null;

  /**
   * Unique identifier for this server instance, used for transport self-echo filtering.
   *
   * @remarks
   * When the transport broadcasts a message, every instance (including the sender) receives
   * it. The sender uses `instanceId` to detect and discard its own re-delivered messages
   * so they are not dispatched to local sockets twice.
   */
  readonly instanceId: string;

  /**
   * Whether presence tracking is enabled on at least one WebSocket endpoint.
   *
   * @remarks
   * Set to `true` during `createServer()` if any endpoint’s channel config has
   * `presence: true`. Controls whether presence-related state (`socketUsers`,
   * `roomPresence`) is populated and maintained at runtime.
   */
  readonly presenceEnabled: boolean;

  /**
   * Active subscriptions registry: room key → Set of socket IDs.
   *
   * @remarks
   * Room keys follow the pattern `{endpoint}:{storageName}:{entityId}:{channelName}`.
   * Entries are added on subscribe and removed on unsubscribe or socket close.
   * The live `Set` is shared by reference — mutations are immediately visible to all
   * readers (no copy-on-write).
   */
  readonly roomRegistry: Map<string, Set<string>>;

  /**
   * Heartbeat socket registry: socket ID → socket handle, endpoint name, and next-timeout epoch.
   *
   * @remarks
   * Maintained by the heartbeat timer loop. `timeoutAt` is the epoch ms by which the socket
   * must respond to the last ping. Sockets that miss their deadline are closed with code 1001
   * (Going Away). Typed as `unknown` for the socket handle — cast to `ServerWebSocket<SocketData>`
   * at use sites.
   */
  readonly heartbeatSockets: Map<string, { ws: unknown; endpoint: string; timeoutAt: number }>;

  /**
   * Per-endpoint heartbeat timer configuration.
   *
   * @remarks
   * Keyed by endpoint name. `intervalMs` is how often the server sends a ping frame;
   * `timeoutMs` is how long to wait for a pong before closing the connection. Both default
   * to framework-level values when not specified per endpoint.
   */
  readonly heartbeatEndpointConfigs: Map<string, { intervalMs?: number; timeoutMs?: number }>;

  /**
   * Active `setInterval` handle for the heartbeat sweep timer, or `null` when no endpoints
   * have heartbeats configured.
   *
   * @remarks
   * Typed `unknown` to keep `slingshot-core` free of Node.js / Bun timer type imports.
   * Cast to `ReturnType<typeof setInterval>` at use sites in framework code.
   */
  heartbeatTimer: unknown;

  /**
   * Authenticated socket tracking for presence: socket ID → user ID.
   *
   * @remarks
   * Populated when a socket completes auth on a presence-enabled channel. Used to map
   * a disconnecting socket back to its user for presence leave events.
   */
  readonly socketUsers: Map<string, string>;

  /**
   * Presence registry: room key → user ID → Set of socket IDs.
   *
   * @remarks
   * Room key format: `wsEndpointKey(endpoint, room)`. The inner `Set<string>` tracks all
   * socket IDs belonging to the same user in the same room (e.g. multiple browser tabs).
   * A user is considered present in a room as long as their `Set` is non-empty.
   */
  readonly roomPresence: Map<string, Map<string, Set<string>>>;

  /**
   * Opaque socket handles for per-socket message delivery: socket ID → socket handle.
   *
   * @remarks
   * Typed `unknown` because `WsState` lives in `slingshot-core` which cannot import Bun types.
   * Cast to `ServerWebSocket<SocketData>` at use sites in the framework layer with a JSDoc
   * boundary comment documenting the cast.
   */
  readonly socketRegistry: Map<string, unknown>;

  /**
   * Rolling-window rate-limit state per endpoint per socket.
   *
   * @remarks
   * Outer key: endpoint name. Inner key: socket ID. Each `WsRateLimitBucket` tracks the
   * message count and window start time for a single connection. Entries are created on
   * first message and removed when the socket closes.
   */
  readonly rateLimitState: Map<string, Map<string, WsRateLimitBucket>>;

  /**
   * Disconnected session entries held during the recovery window: session ID → entry.
   *
   * @remarks
   * When a client disconnects unexpectedly, its session is stored here until `expiresAt`.
   * On reconnect, the client sends `{ type: ‘recover’, sessionId }` and the framework
   * replays missed messages and re-subscribes the socket to its previous rooms.
   */
  readonly sessionRegistry: Map<string, WsSessionEntry>;

  /**
   * Last delivered message ID per socket: socket ID → message ID.
   *
   * @remarks
   * Updated after each message is successfully delivered. Used as the starting cursor
   * when persisting session entries on disconnect, enabling replay-from-last-seen on recovery.
   */
  readonly lastEventIds: Map<string, string>;
}

/**
 * Upload plugin runtime state stored on the context.
 *
 * Populated by the uploads plugin during `setupPost`. `adapter` is the resolved
 * `StorageAdapter` instance; `config` is the frozen uploads plugin configuration.
 */
export interface UploadRuntimeState {
  /**
   * The resolved storage adapter (S3, R2, disk, etc.), or `null` if not configured.
   *
   * @remarks
   * Typed as `unknown` to avoid a hard dependency on the uploads plugin's `StorageAdapter`
   * type in `slingshot-core`. Cast to `StorageAdapter` at use sites in the uploads plugin.
   * `null` indicates the uploads plugin is installed but no storage backend was configured —
   * upload routes will return 503 until a valid adapter is provided.
   */
  readonly adapter: unknown;

  /**
   * The frozen uploads plugin configuration object.
   *
   * @remarks
   * Typed as `Readonly<Record<string, unknown>>` to keep `slingshot-core` free of a direct
   * dependency on the uploads plugin's concrete config type. Cast to the specific config
   * shape at use sites in the uploads plugin where the structure is known.
   */
  readonly config: Readonly<Record<string, unknown>>;
}

/**
 * Instance-scoped metrics runtime state for the application.
 *
 * Populated by the metrics plugin during `setupPost`. Stores in-process counter,
 * histogram, and gauge data for the Prometheus-style metrics endpoint. All maps
 * are instance-scoped — no shared module-level state across app instances.
 *
 * @remarks
 * This interface is an internal container used by the metrics plugin. Consumer code
 * should use the metrics plugin's public helpers (`incrementCounter`, `recordHistogram`,
 * `registerGauge`) rather than mutating these maps directly.
 */
export interface MetricsState {
  /**
   * Counter time-series storage.
   * Outer key: metric name. Inner key: label-set fingerprint. Value: label map + cumulative count.
   */
  readonly counters: Map<string, Map<string, { labels: Record<string, string>; value: number }>>;

  /**
   * Histogram time-series storage.
   * Outer key: metric name. Value: configured bucket boundaries and per-label-set bucket counts,
   * running sum, and observation count.
   */
  readonly histograms: Map<
    string,
    {
      boundaries: number[];
      entries: Map<
        string,
        { labels: Record<string, string>; buckets: number[]; sum: number; count: number }
      >;
    }
  >;

  /**
   * Registered gauge callbacks.
   * Each callback returns the current set of label/value pairs for that gauge metric when
   * the `/metrics` endpoint is scraped.
   */
  readonly gaugeCallbacks: Map<
    string,
    () => Promise<{ labels: Record<string, string>; value: number }[]>
  >;

  /**
   * BullMQ queue handles for queue-depth metrics, or `null` when no queues are configured.
   *
   * @remarks
   * Typed as `Map<string, any>` to avoid a hard BullMQ dependency in `slingshot-core`.
   * Cast to `Map<string, Queue>` at use sites in the metrics plugin.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queues: Map<string, any> | null;
}

/**
 * The instance-scoped runtime state container for a Slingshot application.
 *
 * Created by `createApp()`, attached to the Hono app instance via WeakMap,
 * and accessible from route handlers via `getContext(app)`.
 *
 * Replaces module-level singletons with instance-scoped state. Each
 * `createApp()` invocation produces its own context — no shared globals,
 * no cross-instance leakage.
 */
export interface SlingshotContext {
  /**
   * The Hono app instance this context is attached to.
   *
   * @remarks
   * Typed as `object` rather than `Hono<any>` deliberately. `slingshot-core` must not
   * carry a hard dependency on a specific Hono version — typing this as `Hono` would
   * pin the entire framework to whichever Hono version `slingshot-core` imports, causing
   * version-mismatch issues when consumer apps use a different Hono semver. At use sites
   * in the framework layer (which do import Hono directly) cast with a JSDoc boundary
   * comment: `const app = ctx.app as Hono<AppEnv>`.
   */
  readonly app: object;

  /** Application name. */
  readonly appName: string;

  /** Resolved and frozen application configuration. */
  readonly config: SlingshotResolvedConfig;

  /**
   * Redis client handle, or `null` when Redis is not configured.
   *
   * @remarks
   * `null` means no `redis` block was provided in the app config — all Redis-backed
   * features (distributed rate limiting, session storage, pub/sub transport) will fall
   * back to their in-memory equivalents or throw at startup if Redis is required.
   *
   * Typed as `unknown` to avoid a hard ioredis dependency in `slingshot-core`. Cast to
   * `import('ioredis').Redis` at use sites in framework code that needs the full client API.
   */
  readonly redis: unknown;

  /**
   * Mongoose connection handles, or `null` when Mongo is not configured.
   *
   * @remarks
   * The outer value is `null` when no `mongo` block appears in the app config.
   * When Mongo is configured, the object always exists but individual connections may
   * themselves be `null`: `auth` is `null` when no separate auth database is configured
   * (auth data co-located in the app database), and `app` is `null` when the app
   * has no application-level Mongo collections.
   *
   * Both handles are typed `unknown` to avoid a hard Mongoose dependency in
   * `slingshot-core`. Cast to `import('mongoose').Connection` at framework use sites.
   */
  readonly mongo: { readonly auth: unknown; readonly app: unknown } | null;

  /**
   * Filesystem path to the SQLite database file, or `null` when SQLite is not configured.
   *
   * @remarks
   * Use this to pass the path to packages that need to open their own SQLite connection
   * (e.g. `slingshot-auth` opens the same file for its auth tables). This is the path
   * string only — to read or write data use `ctx.sqliteDb`, which is the already-opened
   * handle owned by the framework.
   */
  readonly sqlite: string | null;

  /**
   * The framework-owned SQLite database handle, or `null` when SQLite is not configured.
   *
   * @remarks
   * Unlike `ctx.sqlite` (the path string), this is the live, already-opened
   * `RuntimeSqliteDatabase` instance. It is closed by `ctx.destroy()` during graceful
   * shutdown. Prefer this handle for reads and writes rather than opening a second
   * connection to the same file.
   */
  readonly sqliteDb: RuntimeSqliteDatabase | null;

  /** Resolved signing configuration, or null when not configured. */
  readonly signing: Readonly<SigningConfig> | null;

  /** Data encryption keys for field-level encryption. Empty array when not configured. */
  readonly dataEncryptionKeys: readonly DataEncryptionKey[];

  /**
   * WebSocket runtime state, or null when the server has no WS endpoints.
   *
   * Set to `null` by `createApp()` — populated by `createServer()` after the Bun server
   * and cross-instance transport are initialised.
   *
   * @remarks
   * **Initialisation timing:** `ws` is intentionally mutable (not `readonly`) so that
   * `createServer()` can attach the `WsState` object after the Hono app and all plugins
   * have been set up. Code that runs during plugin `setupMiddleware`, `setupRoutes`, or
   * `setupPost` phases should not access `ctx.ws` — it will be `null`. Access `ctx.ws`
   * only inside request handlers or after `createServer()` resolves.
   *
   * A `null` value at runtime (post-`createServer`) indicates that the application has no
   * WebSocket endpoints configured. Always null-check before accessing WS state in
   * framework middleware or route handlers.
   */
  ws: WsState | null;

  /**
   * Live WS endpoint config map. Plugins may register `onRoomSubscribe` and
   * `incoming` handlers during `setupPost` by mutating this map. The framework's
   * WS message handler reads these fields at connection time, so mutations made
   * during `setupPost` are visible before any client connects.
   *
   * `null` when the server has no WS endpoints configured.
   *
   * @remarks
   * The map holds the same object reference as the `endpoints` record consumed
   * by the Bun WS handler closure, so writes are immediately reflected.
   *
   * Use `getContext(app).wsEndpoints[endpointName] ??= {}` to create or access
   * an endpoint entry, then set `onRoomSubscribe` or `incoming`.
   */
  wsEndpoints: Record<string, import('../wsHelpers').WsPluginEndpoint> | null;

  /**
   * Standard WS publish function. `null` when WS is not configured.
   *
   * Plugins use this to publish to WS rooms without depending on the framework
   * layer (`src/framework/lib/ws.ts`). Read it in `setupPost` after it has been
   * populated by `createServer()`.
   *
   * @remarks
   * `wsPublish` is populated alongside `wsEndpoints` during server startup.
   * Both are `null` during `setupMiddleware` and `setupRoutes`.
   */
  wsPublish: import('../wsHelpers').WsPublishFn | null;

  /**
   * Resolved persistence repositories — upload registry, idempotency,
   * WS message persistence, and audit log. Instance-scoped, no module-level state.
   */
  readonly persistence: ResolvedPersistence;

  /**
   * Plugin-scoped state map. Plugins store their resolved config or runtime state here
   * during `setupPost()`. Keyed by plugin name (e.g. `'slingshot-auth'`).
   *
   * @remarks
   * **Map vs plain record:** `pluginState` is a `Map` rather than a plain `Record` for
   * three reasons:
   * 1. **Key isolation** — `Map` keys are looked up by identity, not by prototype chain,
   *    so there is no risk of a plugin name colliding with inherited `Object` properties
   *    (`'constructor'`, `'toString'`, etc.).
   * 2. **Dynamic registration** — plugins are registered at runtime, not at type-definition
   *    time. A `Map` makes dynamic `get` / `set` access natural without needing index
   *    signatures that would weaken the type of unrelated keys.
   * 3. **Cross-plugin communication** — plugins that depend on each other can publish
   *    runtime state under stable plugin keys and read it back through package-level
   *    accessors during `setupPost()`, after the peer has already stored its state.
   *    A plain record would require casting an intersection type, which is fragile
   *    when plugins are optional.
   *
   * Values are `unknown` — each plugin is responsible for casting or validating its own
   * state when reading from the map.
   */
  readonly pluginState: Map<string, unknown>;

  /**
   * The sorted list of framework plugins registered with this app instance.
   *
   * @remarks
   * Available after `createApp()` finishes. Used by post-startup lifecycle
   * operations such as `runPluginSeed()`. Plugins appear in topological
   * dependency order (same order as the framework lifecycle phases).
   */
  readonly plugins: readonly import('../plugin').SlingshotPlugin[];

  /**
   * Frozen set of public-path patterns declared by registered plugins.
   *
   * @remarks
   * Read with `isPublicPath(c.req.path, ctx.publicPaths)` inside middleware that should
   * bypass auth, CSRF, tenant resolution, or rate limiting for machine-consumed routes.
   * Patterns support exact matches and `*`-suffix prefix matches.
   */
  readonly publicPaths: ReadonlySet<string>;

  /**
   * Event bus for cross-plugin communication.
   * Replaces the appMeta WeakMap — instance-scoped, no module-level state.
   */
  readonly bus: SlingshotEventBus;

  /**
   * Registry-backed event publish surface for this application instance.
   */
  readonly events: SlingshotEvents;

  /**
   * Optional Kafka connector bridge started by `createApp()`.
   *
   * `null` when the app does not use Kafka inbound/outbound connectors.
   */
  readonly kafkaConnectors: KafkaConnectorHandle | null;

  /**
   * Identity resolver that maps raw auth context variables into a canonical `Actor`.
   *
   * Configured via `CoreRegistrar.setIdentityResolver()` during plugin setup, or
   * defaults to `createDefaultIdentityResolver()` which preserves existing behavior.
   * Custom auth integrations (gateway auth, external IdP, Lambda authorizer) provide
   * their own resolver so all framework consumers get a consistent identity shape
   * without conforming to hardcoded field names.
   */
  readonly identityResolver: IdentityResolver;

  /** Route auth registry for framework-owned routes. */
  readonly routeAuth: RouteAuthRegistry | null;

  /** Request actor resolver used by framework WS/SSE and related helpers. */
  readonly actorResolver: RequestActorResolver | null;

  /** Rate limit adapter used by framework middleware. */
  readonly rateLimitAdapter: RateLimitAdapter | null;

  /** Fingerprint builder used by bot/rate limiting. */
  readonly fingerprintBuilder: FingerprintBuilder | null;

  /** Cache adapters registered for this app instance. */
  readonly cacheAdapters: ReadonlyMap<CacheStoreName, CacheAdapter>;

  /** Email templates registered by plugins for this app instance. */
  readonly emailTemplates: ReadonlyMap<string, EmailTemplate>;

  /** Trusted proxy configuration for IP extraction. */
  readonly trustProxy: false | number;

  /** Upload runtime state for the application instance. */
  readonly upload: UploadRuntimeState | null;

  /** Metrics runtime state for the application instance. */
  readonly metrics: MetricsState;

  /**
   * Secret repository for resolving credentials at runtime.
   * Resolved at startup before DB connections. Plugins and user code
   * can call `ctx.secrets.get(key)` to resolve their own secrets.
   */
  readonly secrets: SecretRepository;

  /**
   * Resolved startup secret snapshot.
   * Contains framework secrets plus any app-specific schema entries resolved
   * during bootstrap. Instance-owned and frozen.
   */
  readonly resolvedSecrets: Readonly<Record<string, string | undefined>>;

  /**
   * Clear all instance-owned in-memory state (stores, caches, registries).
   * Used for test isolation — replaces the old global reset primitive.
   */
  clear(): Promise<void>;

  /**
   * Destroy the context — close database connections, stop timers, release resources.
   * Called during graceful shutdown.
   */
  destroy(): Promise<void>;
}

/**
 * The resolved application configuration stored on `SlingshotContext`.
 *
 * A normalised snapshot of the user-supplied app config after all defaults are applied
 * and all referenced infrastructure handles are resolved. Accessed via `ctx.config`.
 *
 * @remarks
 * **Unknown types for external handles:** several fields (`redis`, `mongo`, `signing`,
 * `captcha`) are typed as `unknown` rather than their concrete types (ioredis `Redis`,
 * Mongoose `Connection`, etc.) to keep `slingshot-core` free of hard dependencies on
 * those packages. Cast them to the correct type at use sites in the framework layer
 * using a JSDoc boundary comment to document the cast.
 *
 * **Frozen at creation:** this object is frozen by `createApp()` before it is stored on
 * `SlingshotContext`. Mutations after creation will be silently ignored in non-strict
 * environments and will throw in strict mode. Build new config snapshots rather than
 * attempting to patch the existing one.
 *
 * **WebSocket configuration:** `SlingshotResolvedConfig` does not carry WebSocket state —
 * WS runtime state is held on `SlingshotContext.ws` which starts as `null` and is populated
 * by `createServer()` after the Bun server initialises. Do not access `ctx.ws` during
 * plugin setup phases; it will always be `null` at that point.
 */
export interface SlingshotResolvedConfig {
  /** Application name. */
  readonly appName: string;
  /** Resolved store selections for sessions, OAuth state, cache, and auth. */
  readonly resolvedStores: Readonly<ResolvedStores>;
  /**
   * Security configuration — currently CORS origins only, but the nested structure
   * is intentional to allow future security settings (CSP, HSTS, etc.) to be added
   * without a breaking shape change.
   *
   * @remarks
   * `cors` is a single origin string or an array of allowed origins passed to the
   * CORS middleware. It is not the full security model — CSRF protection, rate limiting,
   * and bot detection are configured separately.
   */
  readonly security: { readonly cors: string | readonly string[] };
  /** Signing configuration, or null when not configured. */
  readonly signing: unknown;
  /** Data encryption keys. */
  readonly dataEncryptionKeys: readonly DataEncryptionKey[];
  /**
   * Redis client handle, or `undefined` when Redis is not configured.
   *
   * @remarks
   * Typed `unknown` to avoid a hard ioredis dependency in `slingshot-core`. Cast to
   * `import('ioredis').Redis` at framework use sites with a JSDoc boundary comment.
   * Prefer `SlingshotContext.redis` (which normalises `undefined` to `null`) in most code.
   */
  readonly redis: unknown;
  /**
   * Mongoose connection handles, or `undefined` when Mongo is not configured.
   *
   * @remarks
   * Typed `unknown` to avoid a hard Mongoose dependency in `slingshot-core`. Cast to
   * `import('mongoose').Connection` at use sites. Prefer `SlingshotContext.mongo`
   * which normalises `undefined` to `null` for consistent null-checks.
   */
  readonly mongo: { readonly auth: unknown; readonly app: unknown } | undefined;
  /**
   * CAPTCHA provider configuration, or `null` when CAPTCHA is not configured.
   *
   * @remarks
   * Typed `unknown` to keep `slingshot-core` free of a direct dependency on the concrete
   * `CaptchaConfig` type from the auth plugin. Cast to `CaptchaConfig` at use sites in
   * the auth plugin where the shape is known.
   */
  readonly captcha: unknown;
}

export type { SlingshotFrameworkConfig } from './frameworkConfig';
