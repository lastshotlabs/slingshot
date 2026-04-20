import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type {
  AppEnv,
  CoreRegistrar,
  EntityRegistry,
  PluginSetupContext,
  ResolvedEntityConfig,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  InProcessAdapter,
  RESOLVE_ENTITY_FACTORIES,
  attachContext,
} from '@lastshotlabs/slingshot-core';
import { createMemoryWebhookAdapter } from './adapters/memory';
import { createWebhookPlugin } from './plugin';
import type { WebhookAdapter } from './types/adapter';
import type { WebhookPluginConfig } from './types/config';
import { WEBHOOKS_PLUGIN_STATE_KEY } from './types/public';

function unsupportedInfra(name: string): never {
  throw new Error(`Test store infra does not support ${name}`);
}

const memoryInfra: StoreInfra = {
  appName: 'slingshot-webhooks-test',
  getRedis: () => unsupportedInfra('redis'),
  getMongo: () => unsupportedInfra('mongo'),
  getSqliteDb: () => unsupportedInfra('sqlite'),
  getPostgres: () => unsupportedInfra('postgres'),
};

interface WebhooksTestFrameworkOptions {
  storeInfra?: StoreInfra;
  storeType?: StoreType;
  /** When true, use the in-memory adapter instead of slingshot-entity. */
  standalone?: boolean;
}

function createTestFrameworkConfig(options: WebhooksTestFrameworkOptions = {}) {
  const storeInfra = options.storeInfra ?? memoryInfra;
  const storeType = options.storeType ?? ('memory' as StoreType);

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

  const registrar: CoreRegistrar = {
    setIdentityResolver() {},
    setRouteAuth() {},
    setUserResolver() {},
    setRateLimitAdapter() {},
    setFingerprintBuilder() {},
    addCacheAdapter() {},
    addEmailTemplates() {},
  };

  return {
    resolvedStores: {
      sessions: storeType,
      oauthState: storeType,
      cache: storeType,
      authStore: storeType,
      sqlite: undefined,
    },
    security: { cors: '*' },
    signing: null,
    dataEncryptionKeys: [],
    redis: undefined,
    mongo: undefined,
    captcha: null,
    trustProxy: false as const,
    storeInfra,
    registrar,
    entityRegistry,
    password: Bun.password,
    registeredEntities,
  };
}

/**
 * Create a Hono test app with the manifest-driven webhook plugin mounted.
 *
 * Pass `standalone: true` in `frameworkOptions` to boot without `slingshot-entity` —
 * the in-memory adapter is injected automatically.
 */
export async function createWebhooksTestApp(
  configOverrides: Partial<WebhookPluginConfig> = {},
  frameworkOptions: WebhooksTestFrameworkOptions = {},
): Promise<{
  app: OpenAPIHono<AppEnv>;
  runtime: WebhookAdapter;
  bus: InProcessAdapter;
  teardown: () => Promise<void>;
}> {
  const pluginConfig: WebhookPluginConfig = {
    mountPath: '/webhooks',
    managementRole: 'admin',
    ...configOverrides,
    ...(frameworkOptions.standalone && !configOverrides.adapter
      ? { adapter: createMemoryWebhookAdapter() }
      : {}),
  };
  const plugin = createWebhookPlugin(pluginConfig);

  const app = new OpenAPIHono<AppEnv>();
  const bus = new InProcessAdapter();
  const frameworkConfig = createTestFrameworkConfig(frameworkOptions);
  const pluginState = new Map<string, unknown>();

  if (!frameworkOptions.standalone) {
    const { createEntityFactories } = await import('@lastshotlabs/slingshot-entity');
    Reflect.set(
      frameworkConfig.storeInfra as object,
      RESOLVE_ENTITY_FACTORIES,
      createEntityFactories,
    );
  }

  // Simulate the framework's global auth middleware — in production, app.ts mounts
  // auth middleware that populates context variables before any route handler runs.
  // Here we read from x-* headers so tests can control identity per-request.
  app.use('*', (async (c, next) => {
    const userId = c.req.header('x-user-id');
    if (userId) {
      c.set('authUserId', userId);
      c.set('tenantId', c.req.header('x-tenant-id') ?? null);
      c.set('roles', [c.req.header('x-role') ?? 'admin']);
    }
    await next();
  }) as MiddlewareHandler);

  const routeAuth = {
    userAuth: (async (c, next) => {
      if (!c.get('authUserId')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await next();
    }) as MiddlewareHandler,
    requireRole: (...roles: string[]) =>
      (async (c, next) => {
        const activeRoles = (c.get('roles') as string[] | undefined) ?? [];
        if (!roles.some(role => activeRoles.includes(role))) {
          return c.json({ error: 'Forbidden' }, 403);
        }
        await next();
      }) as MiddlewareHandler,
  };

  attachContext(app, {
    pluginState,
    routeAuth,
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
  } as unknown as Parameters<typeof attachContext>[1]);

  const setupContext: PluginSetupContext = {
    app,
    config: frameworkConfig as never,
    bus: bus as unknown as import('@lastshotlabs/slingshot-core').SlingshotEventBus,
  };

  await plugin.setupMiddleware?.(setupContext);
  await plugin.setupRoutes?.(setupContext);
  await plugin.setupPost?.(setupContext);

  const runtime = pluginState.get(WEBHOOKS_PLUGIN_STATE_KEY) as WebhookAdapter | undefined;
  if (!runtime) {
    throw new Error('Webhook plugin did not register runtime state');
  }
  return {
    app,
    runtime,
    bus,
    teardown: async () => {
      await plugin.teardown?.();
    },
  };
}

export { createWebhookMemoryQueue } from './queues/memory';
