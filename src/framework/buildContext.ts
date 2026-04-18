/**
 * SlingshotContext assembly — extracted from createApp().
 *
 * Constructs the immutable context object that is attached to the Hono app and
 * accessible from all middleware and route handlers via c.get('slingshotCtx').
 * Also owns the clear() and destroy() lifecycle methods.
 */
import type { PermissionsConfig } from '@config/types/permissions';
import type { UploadConfig } from '@config/types/upload';
import type { InfrastructureResult } from '@framework/createInfrastructure';
import { closeMetricsQueues, resetMetrics } from '@framework/metrics/registry';
import type { MetricsState } from '@framework/metrics/registry';
import { createContextStoreInfra } from '@framework/persistence/createContextStoreInfra';
import { attachContextStoreInfra } from '@framework/persistence/internalRepoResolution';
import { runPluginTeardown } from '@framework/runPluginLifecycle';
import type { ResolvedSecretBundle } from '@framework/secrets/resolveSecretBundle';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { SigningConfig } from '@lib/signingConfig';
import type {
  CaptchaConfig,
  CoreRegistrarSnapshot,
  SlingshotContext,
  SlingshotEventBus,
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';
import { PERMISSIONS_STATE_KEY, deepFreeze, resolveRepoAsync } from '@lastshotlabs/slingshot-core';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function clearIfPresent(value: unknown): Promise<void> {
  const clear = (value as { clear?: () => Promise<void> | void } | null | undefined)?.clear;
  if (typeof clear === 'function') {
    await clear.call(value);
  }
}

function freezePublishedContract<T>(value: T): T {
  if (value && typeof value === 'object') {
    return Object.freeze(value);
  }
  return value;
}

function cloneAndFreezeConfig<T extends object>(value: T | null | undefined): Readonly<T> | null {
  if (!value) return null;
  return deepFreeze(structuredClone(value));
}

function createReadonlySetView<T>(values: Iterable<T>): ReadonlySet<T> {
  const backing = new Set(values);
  const collectValues = <U>(other: ReadonlySetLike<U>): U[] => {
    const resolved: U[] = [];
    const iterator = other.keys();
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      resolved.push(next.value);
    }
    return resolved;
  };
  const view: ReadonlySet<T> = {
    get size() {
      return backing.size;
    },
    has(value: T): boolean {
      return backing.has(value);
    },
    entries(): SetIterator<[T, T]> {
      return backing.entries();
    },
    keys(): SetIterator<T> {
      return backing.keys();
    },
    values(): SetIterator<T> {
      return backing.values();
    },
    forEach(
      callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void,
      thisArg?: unknown,
    ): void {
      backing.forEach((value1, value2) => {
        callbackfn.call(thisArg, value1, value2, view);
      });
    },
    union<U>(other: ReadonlySetLike<U>): Set<T | U> {
      const result = new Set<T | U>(backing);
      for (const value of collectValues(other)) {
        result.add(value);
      }
      return result;
    },
    intersection<U>(other: ReadonlySetLike<U>): Set<T & U> {
      const result = new Set<T & U>();
      for (const value of backing) {
        if (other.has(value as unknown as U)) {
          result.add(value as T & U);
        }
      }
      return result;
    },
    difference<U>(other: ReadonlySetLike<U>): Set<T> {
      const result = new Set<T>();
      for (const value of backing) {
        if (!other.has(value as unknown as U)) {
          result.add(value);
        }
      }
      return result;
    },
    symmetricDifference<U>(other: ReadonlySetLike<U>): Set<T | U> {
      const result = new Set<T | U>();
      for (const value of backing) {
        if (!other.has(value as unknown as U)) {
          result.add(value);
        }
      }
      for (const value of collectValues(other)) {
        if (!backing.has(value as unknown as T)) {
          result.add(value);
        }
      }
      return result;
    },
    isSubsetOf(other: ReadonlySetLike<unknown>): boolean {
      for (const value of backing) {
        if (!other.has(value)) {
          return false;
        }
      }
      return true;
    },
    isSupersetOf(other: ReadonlySetLike<unknown>): boolean {
      for (const value of collectValues(other)) {
        if (!backing.has(value as T)) {
          return false;
        }
      }
      return true;
    },
    isDisjointFrom(other: ReadonlySetLike<unknown>): boolean {
      for (const value of backing) {
        if (other.has(value)) {
          return false;
        }
      }
      return true;
    },
    [Symbol.iterator](): SetIterator<T> {
      return backing[Symbol.iterator]();
    },
  };

  return Object.freeze(view);
}

function createReadonlyMapView<K, V>(backing: Map<K, V>): ReadonlyMap<K, V> {
  const view: ReadonlyMap<K, V> = {
    get size() {
      return backing.size;
    },
    has(key: K): boolean {
      return backing.has(key);
    },
    get(key: K): V | undefined {
      return backing.get(key);
    },
    entries(): MapIterator<[K, V]> {
      return backing.entries();
    },
    keys(): MapIterator<K> {
      return backing.keys();
    },
    values(): MapIterator<V> {
      return backing.values();
    },
    forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
      backing.forEach((value, key) => {
        callbackfn.call(thisArg, value, key, view);
      });
    },
    [Symbol.iterator](): MapIterator<[K, V]> {
      return backing[Symbol.iterator]();
    },
  };

  return Object.freeze(view);
}

function freezeArrayCopy<T>(value: readonly T[]): readonly T[] {
  return Object.freeze([...value]);
}

const INTERNAL_CACHE_ADAPTERS = Symbol('slingshot.internal.cacheAdapters');
const INTERNAL_EMAIL_TEMPLATES = Symbol('slingshot.internal.emailTemplates');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildContextParams {
  app: OpenAPIHono<AppEnv>;
  appName: string;
  infra: InfrastructureResult;
  signing: SigningConfig | null | undefined;
  captcha: CaptchaConfig | null | undefined;
  upload: UploadConfig | undefined;
  metricsState: MetricsState;
  plugins: readonly SlingshotPlugin[];
  bus: SlingshotEventBus;
  secretBundle: ResolvedSecretBundle;
  /** Server-level permissions config. When set, bootstrap runs before plugin setup. */
  permissions?: PermissionsConfig;
}

/**
 * Apply the plugin-registrar snapshot to the `SlingshotContext` after all plugin
 * phases have completed.
 *
 * This is the single, controlled mutation point for the otherwise-frozen context
 * object.  It writes `routeAuth`, `userResolver`, `rateLimitAdapter`,
 * `fingerprintBuilder`, `cacheAdapters`, and `emailTemplates` from the drained
 * registrar snapshot into the context.
 *
 * @param ctx - The `SlingshotContext` instance to update (already attached to the
 *   app via `attachContextStoreInfra`).
 * @param snapshot - The `CoreRegistrarSnapshot` returned by the registrar's
 *   `drain()` method after all plugin lifecycle phases complete.
 */
export function finalizeContext(ctx: SlingshotContext, snapshot: CoreRegistrarSnapshot): void {
  const mutable = ctx as unknown as {
    routeAuth: CoreRegistrarSnapshot['routeAuth'];
    userResolver: CoreRegistrarSnapshot['userResolver'];
    rateLimitAdapter: CoreRegistrarSnapshot['rateLimitAdapter'];
    fingerprintBuilder: CoreRegistrarSnapshot['fingerprintBuilder'];
    [INTERNAL_CACHE_ADAPTERS]?: Map<unknown, unknown>;
    [INTERNAL_EMAIL_TEMPLATES]?: Map<string, unknown>;
    cacheAdapters: Map<unknown, unknown>;
    emailTemplates: Map<string, unknown>;
  };
  mutable.routeAuth = snapshot.routeAuth ? freezePublishedContract(snapshot.routeAuth) : null;
  mutable.userResolver = snapshot.userResolver
    ? freezePublishedContract(snapshot.userResolver)
    : null;
  mutable.rateLimitAdapter = snapshot.rateLimitAdapter
    ? freezePublishedContract(snapshot.rateLimitAdapter)
    : null;
  mutable.fingerprintBuilder = snapshot.fingerprintBuilder
    ? freezePublishedContract(snapshot.fingerprintBuilder)
    : null;
  const cacheAdapters = mutable[INTERNAL_CACHE_ADAPTERS] ?? mutable.cacheAdapters;
  const emailTemplates = mutable[INTERNAL_EMAIL_TEMPLATES] ?? mutable.emailTemplates;
  cacheAdapters.clear();
  for (const [store, adapter] of snapshot.cacheAdapters) {
    cacheAdapters.set(store, adapter);
  }
  emailTemplates.clear();
  for (const [name, template] of snapshot.emailTemplates) {
    emailTemplates.set(name, freezePublishedContract(template));
  }
}

/**
 * Construct the `SlingshotContext` object for a `createApp()` invocation.
 *
 * Assembles all infrastructure results, resolved secrets, metrics state, and
 * plugin list into the immutable context shape used throughout the framework.
 * The resulting context is attached to the Hono app via `attachContextStoreInfra`
 * and is accessible in middleware and route handlers via `c.get('slingshotCtx')`.
 *
 * The context owns two lifecycle methods:
 * - `clear()` — resets in-memory state (idempotency, upload registry, WS rooms,
 *   metrics).  Used for test isolation.
 * - `destroy()` — calls `clear()` then closes all connections (Redis, Mongo,
 *   SQLite, secrets provider, metrics queues).  Used for graceful shutdown.
 *
 * @param params - All dependencies required to construct the context.
 *   See {@link BuildContextParams} for the full shape.
 * @returns A fully constructed `SlingshotContext` with all infrastructure bound.
 *   The context is not yet finalised — call {@link finalizeContext} after plugin
 *   lifecycle phases complete to populate `routeAuth`, `cacheAdapters`, etc.
 */
export async function buildContext(params: BuildContextParams): Promise<SlingshotContext> {
  const {
    app,
    appName,
    infra,
    signing,
    captcha,
    upload,
    metricsState,
    plugins,
    bus,
    secretBundle,
  } = params;

  const { sessions, oauthState, cache, authStore, sqlite } = infra.resolvedStores;
  const wsEndpointDraft =
    (
      infra.frameworkConfig.ws as
        | {
            endpoints?: Record<string, Record<string, unknown>>;
          }
        | undefined
    )?.endpoints ?? null;
  const pluginState = new Map<string, unknown>();
  const cacheAdaptersBacking = new Map<unknown, unknown>();
  const emailTemplatesBacking = new Map<string, unknown>();
  const publicPaths = createReadonlySetView(plugins.flatMap(plugin => plugin.publicPaths ?? []));
  let destroyPromise: Promise<void> | null = null;
  const frozenSigning = cloneAndFreezeConfig(signing);
  const frozenCaptcha = cloneAndFreezeConfig(captcha);
  const configMongo = infra.mongo
    ? Object.freeze({ auth: infra.mongo.auth, app: infra.mongo.app })
    : undefined;
  const contextMongo = infra.mongo
    ? Object.freeze({ auth: infra.mongo.auth ?? null, app: infra.mongo.app ?? null })
    : null;
  const storeInfra = createContextStoreInfra({
    appName,
    infra,
    bus,
    pluginState,
    entityRegistry: infra.frameworkConfig.entityRegistry,
  });

  // The decorated storeInfra (with REGISTER_ENTITY, RESOLVE_ENTITY_FACTORIES, etc.)
  // is only available after createContextStoreInfra runs. Update frameworkConfig so
  // plugins that read frameworkConfig.storeInfra in setupRoutes/setupPost get the
  // fully-decorated version, not the bare one set during createInfrastructure.
  infra.frameworkConfig.storeInfra = storeInfra;

  // Bootstrap server-level permissions if configured.
  // Runs before context is attached to the app, so all plugin lifecycle phases
  // (setupMiddleware, setupRoutes, setupPost, setup) can read from pluginState.
  if (params.permissions) {
    let slingshotPermissions: typeof import('@lastshotlabs/slingshot-permissions');
    try {
      slingshotPermissions = await import('@lastshotlabs/slingshot-permissions');
    } catch {
      throw new Error(
        '[slingshot] permissions config requires @lastshotlabs/slingshot-permissions. ' +
          'Run: bun add @lastshotlabs/slingshot-permissions',
      );
    }

    const {
      permissionsAdapterFactories,
      createAuthGroupResolver,
      createPermissionRegistry,
      createPermissionEvaluator,
    } = slingshotPermissions;

    const adapter = await resolveRepoAsync(
      permissionsAdapterFactories,
      params.permissions.adapter,
      storeInfra,
    );
    const registry = createPermissionRegistry();
    const evaluator = createPermissionEvaluator({
      registry,
      adapter,
      groupResolver: createAuthGroupResolver(
        () => pluginState.get('slingshot-auth') as { adapter?: object } | null | undefined,
      ),
    });

    pluginState.set(PERMISSIONS_STATE_KEY, Object.freeze({ evaluator, registry, adapter }));
  }

  const ctx: SlingshotContext = {
    app,
    appName: storeInfra.appName,
    config: Object.freeze({
      appName,
      resolvedStores: Object.freeze({ sessions, oauthState, cache, authStore, sqlite }),
      security: Object.freeze({
        cors: Array.isArray(infra.corsOrigins)
          ? freezeArrayCopy(infra.corsOrigins)
          : infra.corsOrigins,
      }),
      signing: frozenSigning,
      dataEncryptionKeys: Object.freeze([...infra.dataEncryptionKeys]),
      redis: infra.redis ?? undefined,
      mongo: configMongo,
      captcha: frozenCaptcha,
    }),
    redis: infra.redis ?? null,
    mongo: contextMongo,
    sqlite: sqlite ?? null,
    sqliteDb: infra.sqliteDb ?? null,
    signing: frozenSigning,
    dataEncryptionKeys: Object.freeze([...infra.dataEncryptionKeys]),
    ws: null,
    wsEndpoints: wsEndpointDraft
      ? (Object.fromEntries(
          Object.entries(wsEndpointDraft).map(([path, endpoint]) => [path, { ...endpoint }]),
        ) as SlingshotContext['wsEndpoints'])
      : null,
    wsPublish: null,
    persistence: infra.persistence,
    pluginState,
    publicPaths,
    plugins: Object.freeze([...plugins]),
    bus,
    routeAuth: null,
    userResolver: null,
    rateLimitAdapter: null,
    fingerprintBuilder: null,
    cacheAdapters: createReadonlyMapView(cacheAdaptersBacking) as SlingshotContext['cacheAdapters'],
    emailTemplates: createReadonlyMapView(
      emailTemplatesBacking,
    ) as SlingshotContext['emailTemplates'],
    trustProxy: infra.frameworkConfig.trustProxy,
    upload: upload
      ? {
          adapter: upload.storage,
          config: Object.freeze({
            maxFileSize: upload.maxFileSize,
            maxFiles: upload.maxFiles,
            allowedMimeTypes: upload.allowedMimeTypes
              ? freezeArrayCopy(upload.allowedMimeTypes)
              : undefined,
            keyPrefix: upload.keyPrefix,
            generateKey: upload.generateKey,
            tenantScopedKeys: upload.tenantScopedKeys,
          }),
        }
      : null,
    metrics: metricsState,
    secrets: secretBundle.provider,
    resolvedSecrets: Object.freeze({ ...secretBundle.merged }),
    async clear() {
      resetMetrics(this.metrics);
      await clearIfPresent(this.persistence.idempotency);
      await clearIfPresent(this.persistence.uploadRegistry);
      await clearIfPresent(this.persistence.wsMessages);
      if (this.ws) {
        this.ws.roomRegistry.clear();
        this.ws.heartbeatSockets.clear();
        this.ws.heartbeatEndpointConfigs.clear();
        this.ws.socketUsers.clear();
        this.ws.roomPresence.clear();
        this.ws.socketRegistry.clear();
        this.ws.rateLimitState.clear();
        this.ws.sessionRegistry.clear();
        this.ws.lastEventIds.clear();
        if (this.ws.heartbeatTimer) {
          clearInterval(this.ws.heartbeatTimer as ReturnType<typeof setInterval>);
          this.ws.heartbeatTimer = null;
        }
      }
    },
    async destroy() {
      if (destroyPromise) return destroyPromise;

      destroyPromise = (async () => {
        try {
          await runPluginTeardown([...this.plugins]);
        } catch {
          /* best-effort */
        }

        if (this.ws?.transport) {
          try {
            await this.ws.transport.disconnect();
          } catch {
            /* best-effort */
          }
          this.ws.transport = null;
        }

        try {
          await this.bus.shutdown?.();
        } catch {
          /* best-effort */
        }

        await this.clear();
        await closeMetricsQueues(this.metrics);
        if (infra.redisEnabled && infra.redis) {
          try {
            const { disconnectRedis } = await import('@lib/redis');
            await disconnectRedis(infra.redis as import('ioredis').default | null);
          } catch {
            /* best-effort */
          }
        }
        if (infra.mongoMode !== false && infra.mongo) {
          try {
            const { disconnectMongo } = await import('@lib/mongo');
            await disconnectMongo(infra.mongo.auth, infra.mongo.app);
          } catch {
            /* best-effort */
          }
        }
        if (infra.sqliteDb) {
          try {
            infra.sqliteDb.close();
          } catch {
            /* best-effort */
          }
        }
        await secretBundle.provider.destroy?.();
      })();

      return destroyPromise;
    },
  };

  Object.defineProperties(ctx, {
    [INTERNAL_CACHE_ADAPTERS]: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: cacheAdaptersBacking,
    },
    [INTERNAL_EMAIL_TEMPLATES]: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: emailTemplatesBacking,
    },
  });

  attachContextStoreInfra(ctx, storeInfra);
  return ctx;
}
