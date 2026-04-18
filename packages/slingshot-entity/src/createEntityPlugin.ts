/**
 * createEntityPlugin — Plugin-level orchestration for config-driven entities.
 *
 * Wires entities into the Slingshot plugin lifecycle:
 *  - setupRoutes: builds bare routes, applies config middleware, mounts onto app
 *  - setupPost:   registers client-safe events, permission resource types
 *  - teardown:    unsubscribes cascade event handlers
 *
 * Consumers wire entities via EntityPluginEntry — either with buildAdapter (manual)
 * or with factories + entityKey (composite, zero-code). This keeps the package
 * free of framework-internal dependencies.
 */
import type { MiddlewareHandler } from 'hono';
import type {
  AppEnv,
  EntityChannelConfig,
  EntityRouteConfig,
  OperationConfig,
  PermissionEvaluator,
  PermissionRegistry,
  PermissionsAdapter,
  PluginSetupContext,
  PolicyResolver,
  ResolvedEntityConfig,
  SlingshotEventBus,
  SlingshotPlugin,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  PERMISSIONS_STATE_KEY,
  RESOLVE_COMPOSITE_FACTORIES,
  RESOLVE_ENTITY_FACTORIES,
  RESOLVE_REINDEX_SOURCE,
  createRouter,
  getContextOrNull,
  resolveRepo,
} from '@lastshotlabs/slingshot-core';
import type {
  ChannelIncomingEventDeclaration,
  RepoFactories,
  WsPublishFn,
} from '@lastshotlabs/slingshot-core';
import type { ChannelConfigDeps } from './channels/applyChannelConfig';
import { buildEntityReceiveHandlers } from './channels/applyChannelConfig';
import { buildSubscribeGuard, wireChannelForwarding } from './channels/applyChannelConfig';
import { buildEntityZodSchemas } from './lib/entityZodSchemas';
import { paginateAdapter } from './lib/paginateAdapter';
import type { EntityManifestRuntime } from './manifest/entityManifestRuntime';
import type { RuntimeHookRef } from './manifest/entityManifestSchema';
import type { MultiEntityManifest } from './manifest/multiEntityManifest';
import { resolveMultiEntityManifest } from './manifest/multiEntityManifest';
import { freezeEntityPolicyRegistry, getEntityPolicyResolver } from './policy/registerEntityPolicy';
import { applyRouteConfig, buildBareEntityRoutes } from './routing';
import type { BareEntityAdapter, RouteConfigDeps } from './routing';
import { buildEventKeyMap, extractEventKey, wireActivityLog } from './wiring/activityLog';
import { wireAutoGrant } from './wiring/autoGrant';
import { createPermissionsResolver } from './wiring/resolvePermissions';

type OpenApiCapableRouter = {
  openapi: (...args: unknown[]) => unknown;
};

function supportsOpenApiRegistration(value: unknown): value is OpenApiCapableRouter {
  return typeof (value as { openapi?: unknown } | null)?.openapi === 'function';
}

/**
 * Plugin-state key under which resolved entity adapters are published.
 *
 * The value stored at this key is a frozen record of adapters keyed by
 * entity name. Consumers such as the SSR plugin read it during `setupPost`.
 */
export const ENTITY_ADAPTERS_KEY = 'entity:adapters';

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/** Shared fields for all `EntityPluginEntry` variants. */
interface EntityPluginEntryBase {
  /** Frozen entity config from `defineEntity()`. */
  config: ResolvedEntityConfig;
  /** Operations from `defineOperations()`, if any. */
  operations?: Record<string, OperationConfig>;
  /** Optional channel config for declarative WebSocket channel wiring. */
  channels?: EntityChannelConfig;
  /**
   * Override the URL path segment derived from the entity name.
   *
   * By default, `entityToPath(config.name)` is used: `Message` → `messages`,
   * `LedgerItem` → `ledger-items`. Set `routePath` to use a different segment
   * without renaming the entity.
   *
   * @example
   * ```ts
   * { config: Snapshot, routePath: 'versions', factories: snapshotFactories, entityKey: 'snapshots' }
   * // Routes: GET /versions, GET /versions/:id, ...
   * ```
   */
  routePath?: string;
  /**
   * Parent path prefix for nested resource URLs.
   *
   * When set, all routes for this entity are mounted under the given prefix.
   * The prefix may include Hono path params (e.g. `':id'`) which are available
   * to middleware and route handlers via `c.req.param()`.
   *
   * Combine with `routePath` to produce fully custom nested paths:
   * `parentPath: '/documents/:id'` + `routePath: 'versions'`
   * → `GET /documents/:id/versions`, `GET /documents/:id/versions/:id`, etc.
   */
  parentPath?: string;
  /**
   * Factory that produces the parent entity adapter for `parentAuth` checks.
   *
   * Required when any operation declares `permission.parentAuth`. Receives the
   * same `storeType` and `infra` as the adapter factory so the parent adapter
   * can be resolved for the active backend.
   */
  buildParentAdapter?: (
    storeType: StoreType,
    infra: StoreInfra,
  ) => { getById(id: string): Promise<unknown> };
}

/**
 * Entity entry backed by a manual adapter factory.
 *
 * Use this when an entity has a custom adapter that cannot be expressed as a
 * composite factory — for example, when the adapter wraps non-standard infra.
 *
 * @example
 * ```ts
 * import { createEntityFactories, resolveRepo } from '@lastshotlabs/slingshot-core';
 *
 * const entry: EntityPluginEntry = {
 *   config: Message,
 *   operations: MessageOps.operations,
 *   buildAdapter: (storeType, infra) =>
 *     resolveRepo(createEntityFactories(Message, MessageOps.operations), storeType, infra),
 * };
 * ```
 */
interface EntityPluginEntryManual extends EntityPluginEntryBase {
  /**
   * Factory called during `setupRoutes` to produce the runtime adapter.
   *
   * @param storeType - The active store type resolved from the framework config.
   * @param infra - The `StoreInfra` providing access to DB handles.
   * @returns A `BareEntityAdapter` with CRUD and named operation methods.
   */
  buildAdapter(storeType: StoreType, infra: StoreInfra): import('./routing').BareEntityAdapter;
}

/**
 * Entity entry backed by config-driven factories — zero-code adapter wiring.
 *
 * Pass any `RepoFactories` object: single-entity factories from
 * `createEntityFactories()` or composite factories from `createCompositeFactories()`.
 *
 * - **Single-entity** (`entityKey` omitted): the resolved object is used as the
 *   adapter directly. Use for the common case where one set of factories produces
 *   one adapter.
 * - **Composite** (`entityKey` present): the plugin resolves the composite, extracts
 *   `composite[entityKey]` as the entity adapter, and automatically mixes any
 *   composite-level operations (e.g. `op.transaction`) onto it — matching by name
 *   against `operations`. Use when the entity shares a composite with others.
 *
 * `onAdapter` is called after resolution with the final adapter. Use it to capture
 * a ref for use in `setupPost` event handlers without writing a closure function.
 *
 * @example Single-entity factories (no entityKey):
 * ```ts
 * { config: Status, operations: statusOperations.operations, factories: statusFactories }
 * ```
 *
 * @example Single-entity with ref capture:
 * ```ts
 * { config: Activity, operations: activityOperations.operations,
 *   factories: activityFactories,
 *   onAdapter: a => { activityAdapterRef = a as ActivityAdapterRef; } }
 * ```
 *
 * @example Composite factories (entityKey required):
 * ```ts
 * { config: Document, operations: documentOperations.operations,
 *   factories: docSnapshotFactories, entityKey: 'documents' }
 * ```
 */
interface EntityPluginEntryFactories extends EntityPluginEntryBase {
  /**
   * Factory set from `createEntityFactories()` or `createCompositeFactories()`.
   * Resolved once per `setupRoutes` call for the active store type.
   */
  factories: RepoFactories<BareEntityAdapter | Record<string, unknown>>;
  /**
   * Key in the composite adapter that holds this entity's sub-adapter.
   * Omit when `factories` is a single-entity `RepoFactories` — the resolved
   * object is used as the adapter directly.
   */
  entityKey?: string;
  /**
   * Called after the adapter is resolved (and composite ops are mixed in).
   * Use to capture a ref for use in `setupPost` without writing a `buildAdapter`
   * closure function.
   *
   * @param adapter - The fully resolved and op-mixed adapter for this entity.
   */
  onAdapter?: (adapter: BareEntityAdapter) => void;
}

/**
 * Describes a single entity wired into an `EntityPlugin`.
 *
 * Two forms are supported:
 * - **`EntityPluginEntryFactories`** (`factories` ± `entityKey`) — zero-code wiring.
 *   Pass single-entity or composite factories; the plugin resolves the adapter and
 *   mixes composite-level ops automatically. Use `onAdapter` to capture a ref.
 * - **`EntityPluginEntryManual`** (`buildAdapter`) — escape hatch for adapters that
 *   cannot be expressed as factories (custom infra, wrapping logic, etc.).
 */
export type EntityPluginEntry = EntityPluginEntryManual | EntityPluginEntryFactories;

function resolveCompositeEntityAdapter(
  resolved: Record<string, unknown>,
  entityKey: string,
  config: ResolvedEntityConfig,
): BareEntityAdapter | undefined {
  const candidateKeys = new Set([entityKey, config.name, config._storageName]);
  for (const key of candidateKeys) {
    const candidate = resolved[key];
    if (candidate && typeof candidate === 'object') {
      return candidate as BareEntityAdapter;
    }
  }
  return undefined;
}

/**
 * Resolve the `BareEntityAdapter` for an entry, handling both the manual
 * `buildAdapter` path and the factories path.
 *
 * **Manual path** (`buildAdapter`): delegates directly to the user-provided factory.
 *
 * **Factories path** (`factories` + optional `entityKey`):
 * - Without `entityKey`: `resolveRepo(factories, ...)` returns the adapter directly.
 * - With `entityKey`: resolves composite, extracts `composite[entityKey]`, and mixes
 *   any composite-level op present in `entry.operations` but absent on the sub-adapter.
 *
 * In both factories cases, `onAdapter` is called with the final adapter if provided.
 */
function resolveEntryAdapter(
  entry: EntityPluginEntry,
  storeType: StoreType,
  infra: StoreInfra,
): BareEntityAdapter {
  if ('buildAdapter' in entry) {
    return entry.buildAdapter(storeType, infra);
  }

  const resolved = resolveRepo(entry.factories, storeType, infra);
  const compositeKey = entry.entityKey;
  const compositeResolved = compositeKey ? (resolved as Record<string, unknown>) : null;

  // Single-entity path: resolved object IS the adapter.
  // Composite path: extract the sub-adapter by entityKey.
  const entityAdapter = compositeKey
    ? resolveCompositeEntityAdapter(resolved as Record<string, unknown>, compositeKey, entry.config)
    : resolved;

  if (!entityAdapter || typeof entityAdapter !== 'object') {
    const label = entry.entityKey
      ? `key '${entry.entityKey}' for entity '${entry.config.name}'`
      : `entity '${entry.config.name}'`;
    throw new Error(`[EntityPlugin] Could not resolve adapter for ${label}`);
  }

  // Mix composite-level ops onto a shallow copy of the entity adapter.
  // Only runs for the composite path (entityKey present) — single-entity factories
  // already have all their methods wired by the factory itself.
  const adapterSource = entityAdapter as BareEntityAdapter & Record<string, unknown>;
  const adapter: BareEntityAdapter & Record<string, unknown> = { ...adapterSource };
  if (compositeResolved) {
    for (const opName of Object.keys(entry.operations ?? {})) {
      const compositeOp = compositeResolved[opName];
      if (typeof compositeOp === 'function' && typeof adapter[opName] !== 'function') {
        adapter[opName] = compositeOp;
      }
    }
  }

  entry.onAdapter?.(adapter);
  return adapter;
}

/**
 * Shape of the `createEntityFactories` function injected by the framework
 * bootstrap via `RESOLVE_ENTITY_FACTORIES`. The package uses this type only
 * at the call site — never imports `createEntityFactories` directly.
 */
type EntityFactoryCreator = (
  config: ResolvedEntityConfig,
  operations?: Record<string, OperationConfig>,
) => RepoFactories<Record<string, unknown>>;

/**
 * Shape of the `createCompositeFactories` function injected via `RESOLVE_COMPOSITE_FACTORIES`.
 */
type CompositeFactoryCreator = (
  entities: Record<
    string,
    { config: ResolvedEntityConfig; operations: Record<string, OperationConfig> }
  >,
  operations?: Record<string, OperationConfig>,
) => RepoFactories<Record<string, unknown>>;

type ManifestResolvedEntry = EntityPluginEntryManual & {
  manifestAdapterTransforms?: RuntimeHookRef[];
};

type SetupRoutePlanEntry = {
  entry: EntityPluginEntry;
  adapter: BareEntityAdapter;
};

/**
 * Resolve a `MultiEntityManifest` into `EntityPluginEntryManual[]`.
 *
 * Each entry's `buildAdapter` closure uses the `RESOLVE_ENTITY_FACTORIES`
 * Reflect symbol injected by the framework bootstrap to create `RepoFactories`
 * at `setupRoutes` time without importing `createEntityFactories` directly
 * (CLAUDE.md Rule 16).
 *
 * Entities that appear in a composite group are NOT added as standalone entries.
 * For each composite, one `EntityPluginEntryManual` is created using the group's
 * `entityKey` as the primary entity. Composite-level ops (e.g. `op.transaction`)
 * are merged onto the resolved adapter, matching the `EntityPluginEntryFactories`
 * composite path behaviour.
 *
 * @internal Not exported — only called from `createEntityPlugin` when `manifest` is set.
 */
function resolveManifestEntries(
  manifest: MultiEntityManifest,
  runtime?: EntityManifestRuntime,
): ManifestResolvedEntry[] {
  const resolved = resolveMultiEntityManifest(manifest, runtime?.customHandlers);
  const entries: ManifestResolvedEntry[] = [];
  const inComposite = new Set<string>();

  for (const composite of Object.values(resolved.composites)) {
    for (const key of composite.entities) inComposite.add(key);
  }

  // Composite entries — one entry per composite keyed by entityKey.
  for (const composite of Object.values(resolved.composites)) {
    const entityEntry = resolved.entities[composite.entityKey];
    const compositeEntityMap = Object.fromEntries(
      composite.entities.map(key => [key, resolved.entities[key]]),
    );
    const compositeOps = composite.operations;
    const manifestEntities = manifest.entities as Record<
      string,
      (typeof manifest.entities)[string] | undefined
    >;
    const manifestEntityEntry = manifestEntities[composite.entityKey];
    const compositeRoutePath = manifestEntityEntry?.routePath;

    // Register OpenAPI schemas for composite sub-entities (non-entityKey).
    // These entities don't get their own route entries, so buildBareEntityRoutes
    // is never called for them — register their schemas explicitly here.
    for (const key of composite.entities) {
      if (key !== composite.entityKey) {
        buildEntityZodSchemas(resolved.entities[key].config);
      }
    }

    const compositeEntry: ManifestResolvedEntry = {
      config: entityEntry.config,
      operations: entityEntry.operations,
      channels: manifestEntityEntry?.channels,
      routePath: compositeRoutePath,
      manifestAdapterTransforms: manifestEntityEntry?.adapterTransforms,
      buildAdapter(storeType: StoreType, infra: StoreInfra): BareEntityAdapter {
        const compositeCreator = Reflect.get(infra as object, RESOLVE_COMPOSITE_FACTORIES) as
          | CompositeFactoryCreator
          | undefined;
        if (!compositeCreator) {
          throw new Error(
            `[EntityPlugin] Manifest-driven composite entities require the framework to inject RESOLVE_COMPOSITE_FACTORIES. ` +
              `Ensure you are using createContextStoreInfra from the Slingshot framework bootstrap.`,
          );
        }
        const factories = compositeCreator(compositeEntityMap, compositeOps);
        const compositeResolved = resolveRepo(factories, storeType, infra);
        const entityAdapter = resolveCompositeEntityAdapter(
          compositeResolved,
          composite.entityKey,
          entityEntry.config,
        );
        if (!entityAdapter || typeof entityAdapter !== 'object') {
          throw new Error(
            `[EntityPlugin] Composite factory did not produce an adapter for entityKey '${composite.entityKey}'`,
          );
        }
        // Mix composite-level ops onto the entity adapter (same as EntityPluginEntryFactories composite path)
        const adapter: BareEntityAdapter & Record<string, unknown> = { ...entityAdapter };
        for (const opName of Object.keys(compositeOps)) {
          if (
            typeof compositeResolved[opName] === 'function' &&
            typeof adapter[opName] !== 'function'
          ) {
            adapter[opName] = compositeResolved[opName];
          }
        }
        return adapter;
      },
    };
    entries.push(compositeEntry);
  }

  // Standalone entries — entities not in any composite.
  for (const [key, { config, operations }] of Object.entries(resolved.entities)) {
    if (inComposite.has(key)) continue;
    const standaloneManifestEntry = (
      manifest.entities as Record<string, (typeof manifest.entities)[string] | undefined>
    )[key];
    const standaloneEntry: ManifestResolvedEntry = {
      config,
      operations,
      channels: standaloneManifestEntry?.channels,
      routePath: standaloneManifestEntry?.routePath,
      manifestAdapterTransforms: standaloneManifestEntry?.adapterTransforms,
      buildAdapter(storeType: StoreType, infra: StoreInfra): BareEntityAdapter {
        const factoryCreator = Reflect.get(infra as object, RESOLVE_ENTITY_FACTORIES) as
          | EntityFactoryCreator
          | undefined;
        if (!factoryCreator) {
          throw new Error(
            `[EntityPlugin] Manifest-driven entities require the framework to inject RESOLVE_ENTITY_FACTORIES. ` +
              `Ensure you are using createContextStoreInfra from the Slingshot framework bootstrap.`,
          );
        }
        const factories = factoryCreator(config, operations);
        return resolveRepo(factories, storeType, infra) as unknown as BareEntityAdapter;
      },
    };
    entries.push(standaloneEntry);
  }

  return entries;
}

/**
 * Configuration for the `createEntityPlugin()` factory.
 *
 * Entities can be wired in two ways — only one may be used per plugin:
 *
 * - **`entities`** — TypeScript `EntityPluginEntry[]`. Use when entities are
 *   defined in code via `defineEntity()` + `defineOperations()`.
 * - **`manifest`** — A `MultiEntityManifest` JSON object. The plugin resolves
 *   it internally and creates all factories. Use for fully declarative plugins.
 *
 * @example Entities path:
 * ```ts
 * createEntityPlugin({
 *   name: 'chat',
 *   mountPath: '/chat',
 *   entities: [{ config: Message, operations: MessageOps.operations, factories: messageFactories }],
 * });
 * ```
 *
 * @example Manifest path (preferred for standard entities):
 * ```ts
 * import manifest from './chat.manifest.json';
 *
 * createEntityPlugin({ name: 'chat', mountPath: '/chat', manifest });
 * ```
 */
export interface EntityPluginConfig {
  /** Plugin name — must be unique across all plugins in the app. */
  name: string;
  /** Names of other plugins this plugin depends on. */
  dependencies?: string[];
  /**
   * Base path under which all entity routes are mounted.
   * When omitted, routes are mounted at the app root.
   */
  mountPath?: string;
  /**
   * Default OpenAPI tag applied to all entity routes in this plugin.
   * When omitted, each entity uses its own name as the tag.
   */
  defaultTag?: string;
  /**
   * Entity entries defined in TypeScript. Mutually exclusive with `manifest`.
   * Use `EntityPluginEntryFactories` (`factories` ± `entityKey`) for zero-code
   * wiring, or `EntityPluginEntryManual` (`buildAdapter`) as an escape hatch.
   */
  entities?: EntityPluginEntry[];
  /**
   * JSON manifest defining all entities declaratively. The plugin resolves the
   * manifest internally and creates all factories via the framework's
   * `createEntityFactories` / `createCompositeFactories` (injected at startup).
   * Mutually exclusive with `entities`.
   *
   * @example
   * ```ts
   * import manifest from './content.manifest.json';
   * createEntityPlugin({ name: 'content', manifest, permissions, setupPost: ... })
   * ```
   */
  manifest?: MultiEntityManifest;
  /**
   * Runtime services for manifest-driven plugins.
   *
   * Use this to provide:
   * - custom operation handlers referenced from manifest `custom` ops
   * - adapter transforms referenced from `adapterTransforms`
   * - lifecycle hooks referenced from `hooks.afterAdapters`
   *
   * Ignored when `entities` is used instead of `manifest`.
   */
  manifestRuntime?: EntityManifestRuntime;
  /**
   * Named middleware handlers referenced by entity route configs.
   * Keys must match the names used in `EntityRouteConfig.middleware`.
   */
  middleware?: Record<string, MiddlewareHandler>;
  /**
   * Factory that produces a rate-limit middleware from options.
   * Required when any entity route config uses `rateLimit`.
   */
  rateLimitFactory?: RouteConfigDeps['rateLimitFactory'];
  /**
   * Permissions wiring. When omitted, the plugin falls back to the
   * `slingshot-permissions` pluginState (populated by the permissions plugin at
   * startup). If neither source provides permissions, permission-guarded routes
   * will have no evaluator. All three components must be provided together when
   * specified explicitly.
   */
  permissions?: {
    evaluator: PermissionEvaluator;
    registry: PermissionRegistry;
    adapter: PermissionsAdapter;
  };
  /**
   * WS endpoint name to attach entity channels to.
   * Defaults to `'entities'`. Must match a key in the app's `WsConfig.endpoints`.
   */
  wsEndpoint?: string;
  /**
   * Optional hook called at the end of `setupPost` with the plugin context.
   * Use this to subscribe to events, initialise shared state, or perform
   * post-startup tasks that depend on all entities being registered.
   */
  setupPost?: (ctx: EntityPluginContext) => void | Promise<void>;
}

/**
 * Context object passed to the `EntityPluginConfig.setupPost` hook.
 *
 * Provides access to the event bus, entity entries, and permissions wiring.
 *
 * @example
 * ```ts
 * import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
 * import type { EntityPluginContext } from '@lastshotlabs/slingshot-entity';
 *
 * export const chatPlugin = createEntityPlugin({
 *   name: 'chat',
 *   entities: [...],
 *   setupPost: (ctx: EntityPluginContext) => {
 *     ctx.bus.on('message.created', async (payload) => {
 *       console.log('New message:', payload);
 *     });
 *   },
 * });
 * ```
 */
export interface EntityPluginContext {
  /** The app-scoped event bus. */
  bus: SlingshotEventBus;
  /** All entity entries registered in this plugin. */
  entities: EntityPluginEntry[];
  /** Permissions wiring, if configured. */
  permissions?: EntityPluginConfig['permissions'];
  /**
   * All resolved adapters, keyed by entity name (`config.name`).
   * Populated during `setupRoutes` before `setupPost` is called.
   * Use to capture adapter refs without writing a `buildAdapter` closure.
   *
   * @example
   * ```ts
   * setupPost: ctx => {
   *   activityAdapterRef = ctx.adapters['Activity'] as ActivityAdapterRef;
   * }
   * ```
   */
  adapters: Record<string, BareEntityAdapter>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Typed facade for dynamic event subscription on the bus.
 * SlingshotEventBus uses a typed on/off — we widen to accept arbitrary string keys
 * for cascade event handlers, which fire on consumer-defined event names.
 */
type DynamicEventBus = {
  on(event: string, handler: (payload: Record<string, unknown>) => void | Promise<void>): void;
  off(event: string, handler: (payload: Record<string, unknown>) => void | Promise<void>): void;
};

// ---------------------------------------------------------------------------
// Extended plugin interface
// ---------------------------------------------------------------------------

/**
 * A `SlingshotPlugin` extended with WebSocket channel helpers.
 *
 * Returned by `createEntityPlugin()`. Implements the full plugin lifecycle
 * (`setupRoutes`, `setupPost`, `teardown`) and adds `buildSubscribeGuard`
 * for declarative WebSocket subscribe authorization.
 *
 * @remarks
 * Wire the returned guard into `WsConfig.endpoints[wsEndpoint].onRoomSubscribe`
 * in your app config. The guard is built lazily — call `plugin.buildSubscribeGuard(deps)`
 * after the plugin has been created, passing runtime identity/permission resolvers.
 *
 * @example
 * ```ts
 * import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
 * import type { EntityPlugin } from '@lastshotlabs/slingshot-entity';
 *
 * const chatPlugin: EntityPlugin = createEntityPlugin({ name: 'chat', entities: [...] });
 *
 * // In app config:
 * const guard = chatPlugin.buildSubscribeGuard({
 *   getIdentity: (ws) => (ws as MyWs).user ?? null,
 *   checkPermission: (userId, perm) => permEvaluator.can({ subjectId: userId, subjectType: 'user' }, perm),
 *   middleware: {},
 * });
 * // ws: { endpoints: { entities: { onRoomSubscribe: guard } } }
 * ```
 */
export interface EntityPlugin extends SlingshotPlugin {
  /**
   * Build a combined WebSocket subscribe guard for all entities with channel
   * configs registered in this plugin.
   *
   * The guard parses the room name (`storageName:entityId:channelName`), finds
   * the matching channel declaration, and enforces auth + permissions +
   * middleware in order.
   *
   * @param deps - Runtime dependencies (identity resolution, permission check,
   *   named middleware handlers, optional entity loader).
   * @returns An async function `(ws, room) => Promise<boolean>` that returns
   *   `true` when the subscriber is authorized.
   */
  buildSubscribeGuard(deps: ChannelConfigDeps): (ws: unknown, room: string) => Promise<boolean>;

  /**
   * Build a map of WS incoming event handlers from all `receive`-configured channels.
   *
   * Returns a `Record<string, ChannelIncomingEventDeclaration>` ready to spread into the WS
   * endpoint's `incoming` config. One entry is generated per unique event type declared across all
   * entity channel `receive.events` arrays.
   *
   * Each handler:
   * 1. Extracts `room` from `payload.room` (rejects if missing or invalid).
   * 2. Validates the sender is subscribed to that room (checks `ws.data.rooms`).
   * 3. Validates the event type is whitelisted in the matching channel's `receive.events`.
   * 4. If `toRoom: true` (default), publishes to the room via the app's
   *    registered WS publish function,
   *    excluding the sender when `excludeSender: true` (default).
   *
   * @remarks
   * The returned handlers are auth-gated at `'userAuth'` level — callers may override
   * by wrapping or replacing individual entries in the returned record.
   *
   * `buildReceiveIncoming()` may be called before `setupPost()`. The returned handlers
   * resolve WS runtime state lazily from the app context at message time.
   *
   * @example
   * ```ts
   * endpoints: {
   *   community: {
   *     presence: true,
   *     onRoomSubscribe: communityPlugin.buildSubscribeGuard(deps),
   *     incoming: communityPlugin.buildReceiveIncoming(),
   *   }
   * }
   * ```
   */
  buildReceiveIncoming(): Record<string, ChannelIncomingEventDeclaration>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an `EntityPlugin` from a declarative config.
 *
 * The plugin wires entities into the Slingshot plugin lifecycle:
 *
 * - **`setupRoutes`** — for each entity, calls `buildAdapter()`, registers the
 *   entity in the framework registry, creates a Hono router, applies route
 *   config (auth, permissions, rate limits, middleware, events), mounts bare
 *   CRUD + named operation routes, and wires cascade event handlers.
 * - **`setupPost`** — registers `clientSafeEvents` on the event bus, registers
 *   permission resource types, wires WebSocket channel event forwarding, and
 *   calls the optional `setupPost` hook from the config.
 * - **`teardown`** — unsubscribes all cascade and channel event handlers
 *   registered during `setupRoutes` and `setupPost`.
 *
 * @param pluginConfig - Plugin configuration describing the entities, middleware,
 *   permissions, and WebSocket wiring.
 * @returns A fully functional `EntityPlugin` ready to register with the
 *   Slingshot app.
 *
 * @example
 * ```ts
 * import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
 * import { Message, MessageOps } from './message';
 * import { createEntityFactories, resolveRepo } from '@lastshotlabs/slingshot-core';
 *
 * export const chatPlugin = createEntityPlugin({
 *   name: 'chat',
 *   mountPath: '/chat',
 *   entities: [{
 *     config: Message,
 *     operations: MessageOps.operations,
 *     buildAdapter: (storeType, infra) =>
 *       resolveRepo(createEntityFactories(Message, MessageOps.operations), storeType, infra),
 *   }],
 * });
 * ```
 */
export function createEntityPlugin(pluginConfig: EntityPluginConfig): EntityPlugin {
  if (!pluginConfig.entities && !pluginConfig.manifest) {
    throw new Error(
      `[EntityPlugin:${pluginConfig.name}] Either 'entities' or 'manifest' is required`,
    );
  }
  if (pluginConfig.entities && pluginConfig.manifest) {
    throw new Error(
      `[EntityPlugin:${pluginConfig.name}] 'entities' and 'manifest' are mutually exclusive`,
    );
  }

  // Resolve manifest into entries eagerly — manifest resolution is pure (no infra needed).
  // The buildAdapter closures inside each entry defer factory creation to setupRoutes time.
  const resolvedEntries: Array<EntityPluginEntry | ManifestResolvedEntry> = pluginConfig.manifest
    ? resolveManifestEntries(pluginConfig.manifest, pluginConfig.manifestRuntime)
    : (pluginConfig.entities ?? []);

  const unsubscribers: Array<() => void> = [];
  const resolvedAdapters: Record<string, BareEntityAdapter> = {};
  const resolvePermissions = createPermissionsResolver(pluginConfig.permissions);
  let capturedInfra: import('@lastshotlabs/slingshot-core').StoreInfra | null = null;
  let capturedApp: object | null = null;
  const endpoint = pluginConfig.wsEndpoint ?? 'entities';

  const getAppContext = () => (capturedApp ? getContextOrNull(capturedApp) : null);
  const getWsState = () => getAppContext()?.ws ?? null;
  const publishToWs: WsPublishFn = (state, targetEndpoint, room, data, options) => {
    const publish = getAppContext()?.wsPublish;
    if (!publish) return;
    publish(state, targetEndpoint, room, data, options);
  };

  // When manifest is used without explicit permissions, auto-declare dependency
  // on slingshot-permissions so pluginState is populated before our setupRoutes runs.
  const dependencies =
    pluginConfig.manifest && !pluginConfig.permissions
      ? [...(pluginConfig.dependencies ?? []), 'slingshot-permissions']
      : pluginConfig.dependencies;

  return {
    name: pluginConfig.name,
    dependencies,

    async setupRoutes({ app, config: frameworkConfig, bus }: PluginSetupContext) {
      capturedApp = app;
      const resolvedPermissions = resolvePermissions(app);

      const mountPath = pluginConfig.mountPath ?? '';
      const storeType = frameworkConfig.resolvedStores.authStore;
      const infra = frameworkConfig.storeInfra;
      capturedInfra = infra;
      const routePlan: SetupRoutePlanEntry[] = [];

      for (const entry of resolvedEntries) {
        const rawAdapter = resolveEntryAdapter(entry, storeType, infra);
        const adapter = await applyManifestAdapterTransforms(
          app,
          bus,
          pluginConfig.name,
          entry,
          rawAdapter,
          resolvedAdapters,
          pluginConfig.manifestRuntime,
        );
        const { config } = entry;

        resolvedAdapters[config.name] = adapter;
        routePlan.push({ entry, adapter });

        // 2. Register entity in framework registry
        try {
          frameworkConfig.entityRegistry.register(config);
        } catch {
          // already registered — skip
        }
      }

      await runManifestAfterAdaptersHooks(
        app,
        bus,
        pluginConfig.name,
        pluginConfig.manifest,
        resolvedAdapters,
        resolvedPermissions,
        pluginConfig.manifestRuntime,
      );

      for (const { entry, adapter } of routePlan) {
        const { config, operations } = entry;
        // 3. Build bare routes + apply config (same applyRouteConfig as codegen path).
        // IMPORTANT: applyRouteConfig registers Hono middleware, which must be registered
        // BEFORE route handlers to take effect.
        if (config.routes) {
          // Build operationMethods map from route config for named op HTTP method overrides.
          const operationMethods = Object.fromEntries(
            Object.entries(config.routes.operations ?? {})
              .filter(
                (entry): entry is [string, (typeof entry)[1] & { method: string }] =>
                  !!entry[1].method,
              )
              .map(([name, cfg]) => [name, cfg.method]),
          );
          const parentAdapter = entry.buildParentAdapter
            ? entry.buildParentAdapter(storeType, infra)
            : undefined;

          // Resolve policy resolvers for this entity's route config.
          // Collect all unique resolver keys, look each up in the registry,
          // and throw a startup error if any key is missing.
          const policyResolvers = resolvePolicyResolversForEntity(app, config.routes);
          // Determine the "defaults" policy config (used by buildBareEntityRoutes
          // for the post-fetch pass on get/update/delete).
          const defaultsPolicyConfig = config.routes.defaults?.permission?.policy ?? undefined;
          const defaultsPolicyResolver = defaultsPolicyConfig
            ? policyResolvers.get(defaultsPolicyConfig.resolver)
            : undefined;

          if (supportsOpenApiRegistration(app)) {
            const mountPrefix = [mountPath, entry.parentPath]
              .filter((part): part is string => Boolean(part))
              .map(part => part.replace(/^\/|\/$/g, ''))
              .filter(Boolean)
              .join('/');
            const parentPath = mountPrefix ? `/${mountPrefix}` : undefined;
            applyRouteConfig(app, config, config.routes, {
              adapter,
              bus,
              permissionEvaluator: resolvedPermissions?.evaluator,
              permissionRegistry: resolvedPermissions?.registry,
              rateLimitFactory: pluginConfig.rateLimitFactory,
              middleware: pluginConfig.middleware,
              routePath: entry.routePath,
              parentPath,
              parentAdapter,
              policyResolvers,
            });
            buildBareEntityRoutes(config, operations, adapter, app, {
              routePath: entry.routePath,
              parentPath,
              operationMethods,
              dataScope: config.routes.dataScope,
              policyConfig: defaultsPolicyConfig,
              policyResolver: defaultsPolicyResolver,
              bus,
              tag: pluginConfig.defaultTag,
            });
          } else {
            const router = createRouter();
            const appMountPath = mountPath === '' ? '/' : mountPath;
            const parentPath = entry.parentPath;
            applyRouteConfig(router, config, config.routes, {
              adapter,
              bus,
              permissionEvaluator: resolvedPermissions?.evaluator,
              permissionRegistry: resolvedPermissions?.registry,
              rateLimitFactory: pluginConfig.rateLimitFactory,
              middleware: pluginConfig.middleware,
              routePath: entry.routePath,
              parentPath,
              parentAdapter,
              policyResolvers,
            });
            buildBareEntityRoutes(config, operations, adapter, router, {
              routePath: entry.routePath,
              parentPath,
              operationMethods,
              dataScope: config.routes.dataScope,
              policyConfig: defaultsPolicyConfig,
              policyResolver: defaultsPolicyResolver,
              bus,
              tag: pluginConfig.defaultTag,
            });
            app.route(appMountPath, router);
          }
        }

        // 4. Wire cascade event handlers
        if (config.routes?.cascades) {
          const dynamicBus = bus as unknown as DynamicEventBus;

          for (const cascade of config.routes.cascades) {
            const handler = async (payload: Record<string, unknown>): Promise<void> => {
              const filter = resolveFilterParams(cascade.batch.filter, payload);
              const { items } = await adapter.list({ filter, limit: 1000 });

              if (cascade.batch.action === 'delete') {
                for (const item of items as Record<string, unknown>[]) {
                  await adapter.delete(item[config._pkField] as string);
                }
              } else if (cascade.batch.set) {
                // Resolve `param:foo` references in the set object against the
                // event payload, mirroring the filter resolution above.
                const resolvedSet = resolveFilterParams(cascade.batch.set, payload);
                for (const item of items as Record<string, unknown>[]) {
                  await adapter.update(item[config._pkField] as string, resolvedSet);
                }
              }
            };

            dynamicBus.on(cascade.event, handler);
            unsubscribers.push(() => dynamicBus.off(cascade.event, handler));
          }
        }
      }

      // All entity routes wired — freeze the policy registry so no late
      // registrations can silently affect requests already in flight.
      freezeEntityPolicyRegistry(app);
    },

    async setupPost({ app, bus }: PluginSetupContext) {
      capturedApp = app;
      const resolvedPermissions = resolvePermissions(app);
      const pluginCtx = getContextOrNull(app);

      if (pluginCtx?.pluginState) {
        pluginCtx.pluginState.set(ENTITY_ADAPTERS_KEY, Object.freeze({ ...resolvedAdapters }));
      }

      // Register all client-safe events declared across all entities
      const allClientSafe = resolvedEntries.flatMap(e => e.config.routes?.clientSafeEvents ?? []);
      if (allClientSafe.length > 0) {
        bus.registerClientSafeEvents(allClientSafe);
      }

      // Register permission resource types for all entities
      if (resolvedPermissions) {
        for (const entry of resolvedEntries) {
          const pc = entry.config.routes?.permissions;
          if (pc) {
            try {
              resolvedPermissions.registry.register({
                resourceType: pc.resourceType,
                actions: pc.actions,
                roles: pc.roles ?? {},
              });
            } catch {
              // already registered — skip
            }
          }
        }

        // Publish permissions state for cross-plugin discovery (e.g. admin
        // auto-discovery in setupPost). Only set if no prior plugin has
        // claimed the key — the first plugin wins to keep resolution
        // deterministic across plugin ordering. Frozen at the boundary per
        // CLAUDE.md rule 12.
        if (pluginCtx?.pluginState && !pluginCtx.pluginState.has(PERMISSIONS_STATE_KEY)) {
          pluginCtx.pluginState.set(
            PERMISSIONS_STATE_KEY,
            Object.freeze({
              evaluator: resolvedPermissions.evaluator,
              registry: resolvedPermissions.registry,
              adapter: resolvedPermissions.adapter,
            }),
          );
        }
      }

      // Wire autoGrant for manifest entities that declare it.
      if (pluginConfig.manifest && resolvedPermissions) {
        for (const [entityName, entityDef] of Object.entries(pluginConfig.manifest.entities)) {
          if (!entityDef.autoGrant) continue;
          const rawEvent = entityDef.routes?.create?.event;
          const eventKey = extractEventKey(rawEvent);
          const resourceType = entityDef.routes?.permissions?.resourceType;
          if (!eventKey || !resourceType) {
            console.warn(
              `[autoGrant:${entityName}] Skipping — requires routes.create.event.key ` +
                `and routes.permissions.resourceType to be set.`,
            );
            continue;
          }
          wireAutoGrant(
            bus,
            entityName,
            eventKey,
            entityDef.autoGrant,
            resourceType,
            resolvedPermissions.adapter,
          );
        }
      }

      // Wire activityLog for manifest entities that declare it.
      if (pluginConfig.manifest) {
        for (const [entityName, entityDef] of Object.entries(pluginConfig.manifest.entities)) {
          if (!entityDef.activityLog) continue;
          const targetAdapter = resolvedAdapters[entityDef.activityLog.entity] as
            | { create(data: Record<string, unknown>): Promise<Record<string, unknown>> }
            | undefined;
          if (!targetAdapter) {
            throw new Error(
              `[activityLog:${entityName}] Target entity "${entityDef.activityLog.entity}" ` +
                `not found in resolved adapters. Ensure it is declared in the manifest.`,
            );
          }
          const eventKeyMap = buildEventKeyMap(entityDef);
          wireActivityLog(bus, entityName, entityDef.activityLog, eventKeyMap, targetAdapter);
        }
      }

      // Wire channel event forwarding for entities with channel configs.
      // WS state and publish access resolve lazily from app context at emit time,
      // so this remains valid even before the server has populated ctx.ws.
      for (const entry of resolvedEntries) {
        if (!entry.channels) continue;
        // Freeze channel config at the boundary (CLAUDE.md rule 12).
        // Consumers get immutable data; top-level freeze is sufficient since
        // individual channel declarations are frozen upstream at definition.
        Object.freeze(entry.channels);
        Object.freeze(entry.channels.channels);
        try {
          const unsub = wireChannelForwarding(
            entry.channels,
            entry.config,
            getWsState,
            bus,
            endpoint,
            publishToWs,
          );
          unsubscribers.push(unsub);
        } catch (err) {
          // Surface channel config errors loudly at startup rather than
          // leaving earlier entities' handlers registered in a partial state.
          throw new Error(
            `Failed to wire channel forwarding for entity '${entry.config._storageName}': ${
              err instanceof Error ? err.message : String(err)
            }`,
            { cause: err },
          );
        }
      }

      // Register reindex sources for all entities that have search config.
      // The search admin rebuild route reads this via RESOLVE_REINDEX_SOURCE.
      if (capturedInfra) {
        const reindexRegistry = new Map<string, BareEntityAdapter>();
        for (const entry of resolvedEntries) {
          const searchConfig: typeof entry.config.search | undefined = entry.config.search;
          if (searchConfig !== undefined) {
            const adapter = (resolvedAdapters as Record<string, BareEntityAdapter | undefined>)[
              entry.config.name
            ];
            if (adapter) reindexRegistry.set(entry.config._storageName, adapter);
          }
        }
        Reflect.set(
          capturedInfra,
          RESOLVE_REINDEX_SOURCE,
          (storageName: string): AsyncIterable<Record<string, unknown>> | null => {
            const adapter = reindexRegistry.get(storageName);
            return adapter ? paginateAdapter(adapter) : null;
          },
        );
      }

      await pluginConfig.setupPost?.({
        bus,
        entities: resolvedEntries,
        permissions: resolvedPermissions,
        adapters: resolvedAdapters,
      });
    },

    teardown() {
      for (const unsub of unsubscribers) unsub();
      unsubscribers.length = 0;
      return Promise.resolve();
    },

    buildSubscribeGuard(deps: ChannelConfigDeps) {
      const channelConfigs = new Map<string, EntityChannelConfig>();
      for (const entry of resolvedEntries) {
        if (entry.channels) {
          channelConfigs.set(entry.config._storageName, entry.channels);
        }
      }
      return buildSubscribeGuard(channelConfigs, deps);
    },

    buildReceiveIncoming(): Record<string, ChannelIncomingEventDeclaration> {
      const merged: Record<string, ChannelIncomingEventDeclaration> = {};
      for (const entry of resolvedEntries) {
        if (!entry.channels) continue;
        const handlers = buildEntityReceiveHandlers(
          entry.channels,
          entry.config,
          getWsState,
          publishToWs,
          endpoint,
        );
        Object.assign(merged, handlers);
      }
      return merged;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isManifestResolvedEntry(
  entry: EntityPluginEntry | ManifestResolvedEntry,
): entry is ManifestResolvedEntry {
  return 'manifestAdapterTransforms' in entry;
}

async function applyManifestAdapterTransforms(
  app: import('hono').Hono<import('@lastshotlabs/slingshot-core').AppEnv>,
  bus: SlingshotEventBus,
  pluginName: string,
  entry: EntityPluginEntry | ManifestResolvedEntry,
  rawAdapter: BareEntityAdapter,
  resolvedAdapters: Record<string, BareEntityAdapter>,
  runtime?: EntityManifestRuntime,
): Promise<BareEntityAdapter> {
  if (!isManifestResolvedEntry(entry) || !entry.manifestAdapterTransforms?.length) {
    return rawAdapter;
  }

  if (!runtime?.adapterTransforms) {
    throw new Error(
      `[EntityPlugin:${pluginName}] Entity '${entry.config.name}' declares adapterTransforms ` +
        `but no manifestRuntime.adapterTransforms registry was provided`,
    );
  }

  let adapter = rawAdapter;
  for (const hookRef of entry.manifestAdapterTransforms) {
    if (!runtime.adapterTransforms.has(hookRef.handler)) {
      throw new Error(
        `[EntityPlugin:${pluginName}] Unknown adapter transform '${hookRef.handler}' ` +
          `for entity '${entry.config.name}'. Available: [${runtime.adapterTransforms
            .list()
            .join(', ')}]`,
      );
    }
    const transform = runtime.adapterTransforms.resolve(hookRef.handler);
    const nextAdapter = await transform(adapter, {
      app,
      bus,
      pluginName,
      entityName: entry.config.name,
      adapters: Object.freeze({ ...resolvedAdapters, [entry.config.name]: adapter }),
      params: hookRef.params,
    });
    if (typeof nextAdapter !== 'object') {
      throw new Error(
        `[EntityPlugin:${pluginName}] Adapter transform '${hookRef.handler}' for entity ` +
          `'${entry.config.name}' did not return an adapter object`,
      );
    }
    adapter = nextAdapter;
  }

  return adapter;
}

async function runManifestAfterAdaptersHooks(
  app: import('hono').Hono<import('@lastshotlabs/slingshot-core').AppEnv>,
  bus: SlingshotEventBus,
  pluginName: string,
  manifest: MultiEntityManifest | undefined,
  resolvedAdapters: Record<string, BareEntityAdapter>,
  permissions: unknown,
  runtime?: EntityManifestRuntime,
): Promise<void> {
  const hookRefs = manifest?.hooks?.afterAdapters ?? [];
  if (hookRefs.length === 0) return;

  if (!runtime?.hooks) {
    throw new Error(
      `[EntityPlugin:${pluginName}] Manifest declares hooks.afterAdapters but no ` +
        `manifestRuntime.hooks registry was provided`,
    );
  }

  for (const hookRef of hookRefs) {
    if (!runtime.hooks.has(hookRef.handler)) {
      throw new Error(
        `[EntityPlugin:${pluginName}] Unknown afterAdapters hook '${hookRef.handler}'. ` +
          `Available: [${runtime.hooks.list().join(', ')}]`,
      );
    }
    const hook = runtime.hooks.resolve(hookRef.handler);
    await hook({
      app,
      bus,
      pluginName,
      adapters: Object.freeze({ ...resolvedAdapters }),
      permissions,
      params: hookRef.params,
    });
  }
}

/**
 * Resolve cascade filter params from a trigger event payload.
 *
 * Values of the form "param:<field>" are replaced with the corresponding
 * field from the event payload. All other values are passed through as-is.
 */
function resolveFilterParams(
  filter: Record<string, unknown>,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filter)) {
    resolved[k] = typeof v === 'string' && v.startsWith('param:') ? payload[v.slice(6)] : v;
  }
  return resolved;
}

/**
 * Collect all unique policy resolver keys from an entity's route config,
 * look each one up in the policy registry, and return a resolved map.
 *
 * Throws a startup error if any referenced resolver key has not been
 * registered via `registerEntityPolicy()` during `setupMiddleware`.
 */
function resolvePolicyResolversForEntity(
  app: import('hono').Hono<AppEnv>,
  routeConfig: EntityRouteConfig,
): ReadonlyMap<string, PolicyResolver> {
  const keys = new Set<string>();

  if (routeConfig.defaults?.permission?.policy) {
    keys.add(routeConfig.defaults.permission.policy.resolver);
  }

  for (const opName of ['create', 'get', 'list', 'update', 'delete'] as const) {
    const opConfig = routeConfig[opName];
    if (opConfig?.permission?.policy) {
      keys.add(opConfig.permission.policy.resolver);
    }
  }

  for (const opConfig of Object.values(routeConfig.operations ?? {})) {
    if (opConfig.permission?.policy) {
      keys.add(opConfig.permission.policy.resolver);
    }
  }

  if (keys.size === 0) return new Map();

  const resolved = new Map<string, PolicyResolver>();
  for (const key of keys) {
    const resolver = getEntityPolicyResolver(app, key);
    if (!resolver) {
      throw new Error(
        `createEntityPlugin: policy resolver '${key}' is referenced in route config ` +
          `but was not registered via registerEntityPolicy(). ` +
          `Register it during setupMiddleware before slingshot-entity.setupRoutes runs.`,
      );
    }
    resolved.set(key, resolver);
  }
  return resolved;
}
