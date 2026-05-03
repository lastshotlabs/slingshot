import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type {
  AppEnv,
  CoreRegistrar,
  EntityRegistry,
  MetricsEmitter,
  PluginSetupContext,
  ResolvedEntityConfig,
  SlingshotEvents,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  ANONYMOUS_ACTOR,
  type Actor,
  InProcessAdapter,
  RESOLVE_ENTITY_FACTORIES,
  attachContext,
  createEventDefinitionRegistry,
  createEventPublisher,
  createPluginStateMap,
  defineEvent,
  getActor,
  getActorId,
  readPluginState,
} from '@lastshotlabs/slingshot-core';
import { createMemoryWebhookAdapter } from './adapters/memory';
import { WebhookRuntimeError } from './errors/webhookErrors';
import { createWebhookPlugin } from './plugin';
import type { WebhookAdapter } from './types/adapter';
import type { WebhookPluginConfig } from './types/config';
import { WEBHOOKS_RUNTIME_KEY } from './types/public';

function unsupportedInfra(name: string): never {
  throw new WebhookRuntimeError(`Test store infra does not support ${name}`);
}

const memoryInfra: StoreInfra = {
  appName: 'slingshot-webhooks-test',
  getRedis: () => unsupportedInfra('redis'),
  getMongo: () => unsupportedInfra('mongo'),
  getSqliteDb: () => unsupportedInfra('sqlite'),
  getPostgres: () => unsupportedInfra('postgres'),
};

function registerWebhooksTestAuthDefinitions(events: SlingshotEvents): void {
  if (events.get('auth:login')) return;

  events.register(
    defineEvent('auth:login', {
      ownerPlugin: 'slingshot-auth',
      exposure: ['user-webhook'],
      resolveScope(payload, ctx) {
        return {
          tenantId: payload.tenantId ?? ctx.requestTenantId ?? null,
          userId: payload.userId,
          actorId: ctx.actorId ?? payload.userId,
        };
      },
    }),
  );
}

interface WebhooksTestFrameworkOptions {
  storeInfra?: StoreInfra;
  storeType?: StoreType;
  /** When true, use the in-memory adapter instead of slingshot-entity. */
  standalone?: boolean;
  registerDefinitions?: (events: SlingshotEvents) => void;
  /**
   * Optional unified metrics emitter wired into the framework context so the
   * plugin's setupPost picks it up via `getContextOrNull(app).metricsEmitter`.
   * Defaults to a no-op when omitted.
   */
  metricsEmitter?: MetricsEmitter;
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
    setRequestActorResolver() {},
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
  events: SlingshotEvents;
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
  const events = createEventPublisher({
    definitions: createEventDefinitionRegistry(),
    bus,
  });
  registerWebhooksTestAuthDefinitions(events);
  frameworkOptions.registerDefinitions?.(events);
  const frameworkConfig = createTestFrameworkConfig(frameworkOptions);
  const pluginState = createPluginStateMap();

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
    const tenantId = c.req.header('x-tenant-id') ?? null;
    if (tenantId) {
      c.set('tenantId', tenantId);
    }
    if (userId) {
      const roles = [c.req.header('x-role') ?? 'admin'];
      c.set(
        'actor',
        Object.freeze({
          id: userId,
          kind: 'user',
          tenantId,
          sessionId: null,
          roles,
          claims: {},
        }) as Actor,
      );
    } else {
      c.set('actor', ANONYMOUS_ACTOR);
    }
    await next();
  }) as MiddlewareHandler);

  const routeAuth = {
    userAuth: (async (c, next) => {
      if (!getActorId(c)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await next();
    }) as MiddlewareHandler,
    requireRole: (...roles: string[]) =>
      (async (c, next) => {
        const activeRoles = getActor(c).roles ?? [];
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
    ...(frameworkOptions.metricsEmitter ? { metricsEmitter: frameworkOptions.metricsEmitter } : {}),
  } as unknown as Parameters<typeof attachContext>[1]);

  const setupContext: PluginSetupContext = {
    app,
    config: frameworkConfig as never,
    bus: bus as unknown as import('@lastshotlabs/slingshot-core').SlingshotEventBus,
    events,
  };

  await plugin.setupMiddleware?.(setupContext);
  await plugin.setupRoutes?.(setupContext);
  await plugin.setupPost?.(setupContext);

  const runtime = readPluginState(pluginState, WEBHOOKS_RUNTIME_KEY);
  if (!runtime) {
    throw new WebhookRuntimeError('Webhook plugin did not register runtime state');
  }
  return {
    app,
    runtime,
    bus,
    events,
    teardown: async () => {
      await plugin.teardown?.();
    },
  };
}

export { createWebhookMemoryQueue } from './queues/memory';
