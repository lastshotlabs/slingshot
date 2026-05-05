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
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import {
  createMemoryPermissionsAdapter,
  createPermissionRegistry,
} from '@lastshotlabs/slingshot-permissions';
import { resolveStorageAdapter } from '../adapters/index';
import { memoryStorage } from '../adapters/memory';
import { createAssetFactories } from '../entities/factories';
import { createAssetsPlugin } from '../plugin';
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
 * Create a Hono test app with the assets plugin mounted through its real lifecycle.
 *
 * @param configOverrides - Optional assets plugin config overrides.
 * @returns The configured app and the resolved plugin state.
 */
export async function createAssetsTestApp(
  configOverrides: Partial<AssetsPluginConfig> = {},
): Promise<{ app: Hono; state: AssetsPluginState }> {
  const plugin = createAssetsPlugin({
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

  await plugin.setupMiddleware?.(setupContext);
  await plugin.setupRoutes?.(setupContext);
  await plugin.setupPost?.(setupContext);

  const slot = pluginState.get('slingshot:package:capabilities:slingshot-assets') as
    | { runtime?: import('../types').AssetsPluginState }
    | undefined;
  const state = slot?.runtime;
  if (!state) {
    throw new Error('Assets plugin did not register state');
  }

  return { app, state };
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
