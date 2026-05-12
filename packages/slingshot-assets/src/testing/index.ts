/**
 * Testing utilities for `@lastshotlabs/slingshot-assets`.
 *
 * Import from `@lastshotlabs/slingshot-assets/testing` in package consumers.
 */
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import type {
  CoreRegistrar,
  EntityRegistry,
  PermissionEvaluator,
  PermissionsState,
  ResolvedEntityConfig,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  InProcessAdapter,
  RESOLVE_ENTITY_FACTORIES,
  attachContext,
  createEventDefinitionRegistry,
  createEventPublisher,
  createPluginStateMap,
  publishPluginState,
  resolveRepo,
} from '@lastshotlabs/slingshot-core';
import { createEntityFactories, createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type {
  BareEntityAdapter,
  EntityPluginEntry,
} from '@lastshotlabs/slingshot-entity';
import {
  createMemoryPermissionsAdapter,
  createPermissionRegistry,
} from '@lastshotlabs/slingshot-permissions';
import { resolveStorageAdapter } from '../adapters/index';
import { memoryStorage } from '../adapters/memory';
import { createAssetFactories } from '../entities/factories';
import {
  createPresignDownloadHandler,
  createPresignUploadHandler,
  createServeImageHandler,
} from '../entities/runtime';
import { resolveImageConfig } from '../image/serve';
import { createMemoryImageCache } from '../image/cache';
import type { ImageCacheAdapter } from '../image/types';
import { createAssetsPackage } from '../plugin';
import { noopLogger } from '@lastshotlabs/slingshot-core';
import {
  type Asset,
  type AssetAdapter,
  type AssetsPluginConfig,
  type AssetsPluginState,
  type CreateAssetInput,
} from '../types';

/**
 * Runtime adapter shape with plugin-wired custom operations.
 */
export interface AssetsRuntimeAdapter extends AssetAdapter {
  /** Runtime custom operation for presigned upload URLs. */
  presignUpload(params: Record<string, unknown>): Promise<unknown>;
  /** Runtime custom operation for presigned download URLs. */
  presignDownload(params: Record<string, unknown>): Promise<unknown>;
  /** Runtime custom operation for image serving. */
  serveImage(params: Record<string, unknown>): Promise<Response>;
}

const memoryInfra = {} as unknown as StoreInfra;

function createTestFrameworkConfig() {
  Reflect.set(memoryInfra as object, RESOLVE_ENTITY_FACTORIES, createEntityFactories);
  const registeredEntities: ResolvedEntityConfig[] = [];
  const entityRegistry: EntityRegistry = {
    register(config: ResolvedEntityConfig) {
      registeredEntities.push(config);
    },
    getAll() {
      return registeredEntities;
    },
    filter(predicate: (entity: ResolvedEntityConfig) => boolean) {
      return registeredEntities.filter(predicate);
    },
  };

  const registrar = {
    registerRouteAuth() {},
    build() {
      return { routeAuth: null, permissions: null };
    },
  } as unknown as CoreRegistrar;

  return {
    resolvedStores: {
      sessions: 'memory' as StoreType,
      oauthState: 'memory' as StoreType,
      cache: 'memory' as StoreType,
      authStore: 'memory' as StoreType,
      sqlite: undefined,
    },
    security: { cors: '*' },
    signing: null,
    dataEncryptionKeys: [],
    redis: undefined,
    mongo: undefined,
    captcha: null,
    trustProxy: false as const,
    storeInfra: memoryInfra,
    registrar,
    entityRegistry,
    password: Bun.password,
    registeredEntities,
  };
}

function createOwnerOnlyPermissionsState(): PermissionsState {
  const registry = createPermissionRegistry();
  const adapter = createMemoryPermissionsAdapter();
  const evaluator: PermissionEvaluator = {
    can() {
      return Promise.resolve(false);
    },
  };
  return { evaluator, registry, adapter };
}

/**
 * Create a memory-backed assets plugin state without HTTP routes.
 *
 * @param configOverrides - Optional plugin config overrides.
 * @returns Isolated in-memory assets plugin state for unit tests.
 */
export function createMemoryAssetsState(
  configOverrides: Partial<AssetsPluginConfig> = {},
): AssetsPluginState {
  const storage = resolveStorageAdapter(configOverrides.storage ?? memoryStorage());
  const config: Readonly<AssetsPluginConfig> = Object.freeze({
    mountPath: '/assets',
    storage,
    presignedUrls: true,
    ...configOverrides,
  });
  const assets = resolveRepo(
    createAssetFactories(config.registryTtlSeconds),
    'memory',
    memoryInfra,
  ) as unknown as AssetsPluginState['assets'];
  return {
    assets,
    storage,
    config,
  };
}

/**
 * Create a Hono test app with the assets package mounted through its real lifecycle.
 *
 * The package's `entities: [...]` declaration is processed by the framework's
 * `compilePackages()` during `createApp(...)`. This test helper bypasses that
 * path, so we mount the entity routes manually via `createEntityPlugin`,
 * delegating per-entity `buildAdapter` to each entity module's own wiring so
 * the package's adapter-ref closures fire as they would under the framework
 * path. Mirrors the polls / push / organizations testing helpers.
 *
 * @param configOverrides - Optional assets package config overrides.
 * @returns The configured app and the resolved package runtime state.
 */
export async function createAssetsTestApp(
  configOverrides: Partial<AssetsPluginConfig> = {},
): Promise<{ app: Hono; state: AssetsPluginState }> {
  const pkg = createAssetsPackage({
    mountPath: '/assets',
    storage: resolveStorageAdapter(configOverrides.storage ?? memoryStorage()),
    presignedUrls: true,
    ...configOverrides,
  });

  const app = new Hono();
  const bus = new InProcessAdapter();
  const events = createEventPublisher({
    definitions: createEventDefinitionRegistry(),
    bus,
  });
  const frameworkConfig = createTestFrameworkConfig();
  const pluginState = createPluginStateMap();
  publishPluginState(
    pluginState,
    'slingshot:package:capabilities:slingshot-permissions',
    createOwnerOnlyPermissionsState(),
  );

  attachContext(app, {
    pluginState,
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus,
    events,
  } as unknown as Parameters<typeof attachContext>[1]);

  const routeAuth = {
    userAuth: (async (c, next) => {
      const userId = c.req.header('x-user-id') ?? c.req.header('x-test-user');
      if (!userId) return c.json({ error: 'Unauthorized' }, 401);
      const tenantId = c.req.header('x-tenant-id') ?? null;
      (c as typeof c & { set(key: string, value: unknown): void }).set(
        'actor',
        Object.freeze({
          id: userId,
          kind: 'user',
          tenantId,
          sessionId: null,
          roles: null,
          claims: {},
        }),
      );
      c.set('tenantId', tenantId);
      await next();
    }) as MiddlewareHandler,
    requireRole: () => (async (_c, next) => next()) as MiddlewareHandler,
  };

  app.use('*', async (c, next) => {
    (c as typeof c & { set(key: string, value: unknown): void }).set('slingshotCtx', { routeAuth });
    await next();
  });

  const setupContext = {
    app,
    config: frameworkConfig as never,
    bus: bus as unknown as import('@lastshotlabs/slingshot-core').SlingshotEventBus,
    events,
  } as unknown as import('@lastshotlabs/slingshot-core').PluginSetupContext;

  // Manually mount the package's entity module via `createEntityPlugin`.
  // The `buildAdapter` here delegates to each entity module's
  // `wiring.buildAdapter`, which TTL-wraps the resolved adapter AND populates
  // the package's closure-owned adapter ref. Same dual-population pattern used
  // by slingshot-polls / slingshot-push / slingshot-organizations.
  const entityEntries: EntityPluginEntry[] = pkg.entities.map(entityModule => {
    const impl = (entityModule as { implementation: unknown }).implementation as {
      config: ResolvedEntityConfig;
      operations?: Record<string, unknown>;
      extraRoutes?: unknown;
      overrides?: unknown;
      routePath?: string;
      parentPath?: string;
      wiring: { mode: string; buildAdapter?: unknown };
    };
    const buildAdapter = impl.wiring.buildAdapter as
      | ((storeType: StoreType, infra: unknown) => BareEntityAdapter)
      | undefined;
    if (impl.wiring.mode !== 'manual' || !buildAdapter) {
      throw new Error(
        `[assets test harness] expected manual wiring on entity '${entityModule.entityName}', got '${impl.wiring.mode}'`,
      );
    }
    return {
      config: impl.config,
      operations: impl.operations as never,
      extraRoutes: impl.extraRoutes as never,
      overrides: impl.overrides as never,
      ...(impl.routePath ? { routePath: impl.routePath } : {}),
      ...(impl.parentPath ? { parentPath: impl.parentPath } : {}),
      buildAdapter,
    };
  });

  const entityPlugin = createEntityPlugin({
    name: 'slingshot-assets',
    mountPath: pkg.mountPath ?? '/assets',
    entities: entityEntries,
    middleware: pkg.middleware ? { ...pkg.middleware } : undefined,
  });

  // Lifecycle order matches the framework path:
  //   1. package setupMiddleware     — registers events, captures publisher
  //   2. entity setupMiddleware      — entity-plugin policy hooks
  //   3. entity setupRoutes          — mounts CRUD + named-op routes (runs
  //                                    buildAdapter, populates package refs)
  //   4. package setupRoutes (none)  — assets has no extra setupRoutes
  //   5. entity setupPost / package setupPost — final wiring
  await pkg.setupMiddleware?.(setupContext);
  await entityPlugin.setupMiddleware?.(setupContext);
  await entityPlugin.setupRoutes?.(setupContext);
  await pkg.setupRoutes?.(setupContext);
  await entityPlugin.setupPost?.(setupContext);
  await pkg.setupPost?.(setupContext);

  // `createApp` would do this; the test harness bypasses that path so we
  // manually publish the package's capabilities through plugin state.
  const capabilitySlotKey = `slingshot:package:capabilities:${pkg.name}`;
  const slot: Record<string, unknown> = {};
  for (const provider of pkg.capabilities.provides) {
    const value = await provider.resolve({ packageName: pkg.name });
    slot[provider.capability.name] = value;
  }
  publishPluginState(pluginState, capabilitySlotKey, Object.freeze(slot));

  const runtime = slot.runtime as AssetsPluginState | undefined;
  if (!runtime) {
    throw new Error('Assets package did not publish AssetsRuntimeCap');
  }

  // The package's custom-op handlers (presignUpload, presignDownload,
  // serveImage) live behind entity-route executor overrides — they aren't
  // methods on the adapter. Tests that invoke them directly via
  // `getAssetsRuntimeAdapter(state).serveImage(...)` need synthetic methods
  // on the adapter; we build them here using the same handler factories the
  // package uses internally, sharing the resolved asset adapter and storage.
  const resolvedConfig: Readonly<AssetsPluginConfig> = runtime.config;
  const imageConfig = resolveImageConfig(resolvedConfig.image);
  let testImageCache: ImageCacheAdapter | null = null;
  if (imageConfig != null) {
    const candidate = resolvedConfig.image?.cache;
    const isImageCacheAdapter =
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof Reflect.get(candidate, 'get') === 'function' &&
      typeof Reflect.get(candidate, 'set') === 'function';
    if (isImageCacheAdapter) {
      testImageCache = candidate as ImageCacheAdapter;
    } else {
      const cacheOpts: { maxEntries?: number; ttlMs?: number } = {};
      if (resolvedConfig.image?.cacheMaxEntries !== undefined) {
        cacheOpts.maxEntries = resolvedConfig.image.cacheMaxEntries;
      }
      if (resolvedConfig.image?.cacheTtlMs !== undefined) {
        cacheOpts.ttlMs = resolvedConfig.image.cacheTtlMs;
      }
      testImageCache = createMemoryImageCache(cacheOpts);
    }
  }
  const handlerDeps = {
    config: resolvedConfig,
    storage: runtime.storage,
    imageCache: testImageCache,
    imageConfig,
    logger: noopLogger,
    getAssetAdapter: () => runtime.assets,
  };
  const adapterWithHandlers = runtime.assets as AssetAdapter & {
    presignUpload?: (input: unknown) => Promise<unknown>;
    presignDownload?: (input: unknown) => Promise<unknown>;
    serveImage?: (input: unknown) => Promise<Response>;
  };
  adapterWithHandlers.presignUpload = createPresignUploadHandler(handlerDeps);
  adapterWithHandlers.presignDownload = createPresignDownloadHandler(handlerDeps);
  adapterWithHandlers.serveImage = createServeImageHandler(handlerDeps);

  return { app, state: runtime };
}

/**
 * Seed an asset record in the provided test state.
 *
 * @param state - Assets plugin state from `createAssetsTestApp()` or `createMemoryAssetsState()`.
 * @param input - Partial asset input. `key` is required.
 * @returns The created asset record.
 */
export async function seedAsset(
  state: AssetsPluginState,
  input: Pick<CreateAssetInput, 'key'> & Partial<CreateAssetInput>,
): Promise<Asset> {
  return state.assets.create({
    ownerUserId: 'user-1',
    mimeType: 'application/octet-stream',
    originalName: 'asset.bin',
    ...input,
  });
}

/**
 * Access the plugin-wired runtime adapter with custom operations for direct tests.
 *
 * @param state - Assets plugin state from `createAssetsTestApp()`.
 * @returns The runtime adapter including `presignUpload`, `presignDownload`, and `serveImage`.
 */
export function getAssetsRuntimeAdapter(state: AssetsPluginState): AssetsRuntimeAdapter {
  return state.assets as unknown as AssetsRuntimeAdapter;
}
