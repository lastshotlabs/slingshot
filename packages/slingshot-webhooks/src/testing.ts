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
  SlingshotPackageDefinition,
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
  publishPluginState,
} from '@lastshotlabs/slingshot-core';
import { runPackageLifecycle } from '@lastshotlabs/slingshot-entity/testing';
import { createMemoryWebhookAdapter } from './adapters/memory';
import { WebhookRuntimeError } from './errors/webhookErrors';
import { createWebhooksPackage } from './plugin';
import type { WebhookAdapter } from './types/adapter';
import type { WebhookPluginConfig } from './types/config';

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
 * Create a Hono test app with the `definePackage` webhook package mounted.
 *
 * Mirrors the pattern used by other packages' test harnesses (polls,
 * organizations): the package's entities are mounted manually via
 * `createEntityPlugin`, delegating each entity's `buildAdapter` to the
 * module's own `wiring.buildAdapter` so the package's closure-owned adapter
 * refs are populated.
 *
 * Pass `standalone: true` in `frameworkOptions` to boot without
 * `slingshot-entity` — the in-memory adapter is injected automatically and
 * entity-CRUD routes are skipped.
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
  const pkg: SlingshotPackageDefinition = createWebhooksPackage(pluginConfig);

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

  const useEntityPath = !frameworkOptions.standalone && pkg.entities.length > 0;

  if (useEntityPath) {
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

  // When the entity path is enabled, drive the package's lifecycle the same
  // way `compilePackages()` does — through the shared `runPackageLifecycle`
  // helper. In standalone mode (no entity plugin), we drive `pkg.setup*` hooks
  // directly because there are no entities to mount.
  if (useEntityPath) {
    await runPackageLifecycle(pkg, setupContext);
  } else {
    await pkg.setupMiddleware?.(setupContext);
    await pkg.setupRoutes?.(setupContext);
    await pkg.setupPost?.(setupContext);
  }

  // `createApp` publishes capability provider results into the canonical
  // `slingshot:package:capabilities:<name>` plugin-state slot. Bypassing
  // `createApp` here, we replicate that step so the test helper can read
  // the runtime adapter through the same slot used by docker/e2e callers.
  let runtime: WebhookAdapter | undefined;
  for (const provider of pkg.capabilities.provides) {
    const value = await provider.resolve({ packageName: pkg.name });
    const slotKey = `slingshot:package:capabilities:${pkg.name}`;
    const existing =
      (pluginState.get(slotKey) as Record<string, unknown> | undefined) ?? {};
    publishPluginState(pluginState, slotKey, {
      ...existing,
      [provider.capability.name]: value,
    });
    if (provider.capability.name === 'adapter') {
      runtime = value as WebhookAdapter;
    }
  }

  if (!runtime) {
    throw new WebhookRuntimeError('Webhook package did not register runtime adapter');
  }

  return {
    app,
    runtime,
    bus,
    events,
    teardown: async () => {
      await pkg.teardown?.();
    },
  };
}

export { createWebhookMemoryQueue } from './queues/memory';
