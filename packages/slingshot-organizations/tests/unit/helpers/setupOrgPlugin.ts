import { Hono } from 'hono';
import { type AuthRuntimeContext, createAuthResolvedConfig } from '@lastshotlabs/slingshot-auth';
import {
  createAuthRateLimitService,
  createCredentialStuffingService,
  createLockoutService,
  createMemoryAuthAdapter,
  createMemoryAuthRateLimitRepository,
  createMemoryCredentialStuffingRepository,
  createMemoryDeletionCancelTokenRepository,
  createMemoryLockoutRepository,
  createMemoryMagicLinkRepository,
  createMemoryMfaChallengeRepository,
  createMemoryOAuthCodeRepository,
  createMemoryOAuthReauthRepository,
  createMemoryOAuthStateStore,
  createMemoryResetTokenRepository,
  createMemorySamlRequestIdRepository,
  createMemorySessionRepository,
  createMemoryVerificationTokenRepository,
} from '@lastshotlabs/slingshot-auth/testing';
import {
  InProcessAdapter,
  RESOLVE_ENTITY_FACTORIES,
  type SlingshotContext,
  type SlingshotResolvedConfig,
  attachContext,
  createDefaultIdentityResolver,
  createEntityRegistry,
  getActor,
} from '@lastshotlabs/slingshot-core';
import type {
  AppEnv,
  PluginSetupContext,
  ResolvedEntityConfig,
  RouteAuthRegistry,
  SlingshotFrameworkConfig,
  SlingshotPackageDefinition,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import { createMemoryStoreInfra } from '@lastshotlabs/slingshot-core/testing';
import { createEntityFactories, createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter, EntityPluginEntry } from '@lastshotlabs/slingshot-entity';
import { type OrganizationsPluginConfig, createOrganizationsPackage } from '../../../src/plugin';

function createFrameworkConfig(): SlingshotFrameworkConfig & {
  registeredEntities: ResolvedEntityConfig[];
} {
  const registeredEntities: ResolvedEntityConfig[] = [];
  const entityRegistry = createEntityRegistry();
  const storeInfra = createMemoryStoreInfra();
  Reflect.set(storeInfra as object, RESOLVE_ENTITY_FACTORIES, createEntityFactories);

  const originalRegister = entityRegistry.register.bind(entityRegistry);
  entityRegistry.register = (config: ResolvedEntityConfig) => {
    registeredEntities.push(config);
    return originalRegister(config);
  };

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
    trustProxy: false,
    registrar: {
      setIdentityResolver() {},
      setRouteAuth() {},
      setRequestActorResolver() {},
      setRateLimitAdapter() {},
      setFingerprintBuilder() {},
      addCacheAdapter() {},
      addEmailTemplates() {},
    },
    entityRegistry,
    storeInfra,
    password: Bun.password,
    registeredEntities,
  };
}

async function createTestAuthRuntime(
  bus: InProcessAdapter,
  stores: SlingshotFrameworkConfig['resolvedStores'],
): Promise<{
  runtime: AuthRuntimeContext;
  adminId: string;
  memberId: string;
}> {
  const adapter = createMemoryAuthAdapter(() =>
    createAuthResolvedConfig({
      emailVerification: { required: false },
    }),
  );
  const admin = await adapter.create('admin@example.com', 'hash');
  const member = await adapter.create('member@example.com', 'hash');
  if (!adapter.addRole || !adapter.setEmailVerified) {
    throw new Error('memory auth adapter is missing required test helpers');
  }
  await adapter.addRole(admin.id, 'admin');
  await adapter.setEmailVerified(admin.id, true);
  await adapter.setEmailVerified(member.id, true);

  const runtime: AuthRuntimeContext = {
    adapter,
    eventBus: bus,
    config: createAuthResolvedConfig({
      emailVerification: { required: false },
    }),
    stores,
    password: Bun.password,
    getDummyHash: async () => 'dummy-hash',
    signing: null,
    dataEncryptionKeys: [],
    oauth: {
      providers: {},
      stateStore: createMemoryOAuthStateStore(),
    },
    lockout: createLockoutService(
      { maxAttempts: 5, lockoutDuration: 60, resetOnSuccess: true },
      createMemoryLockoutRepository(),
    ),
    rateLimit: createAuthRateLimitService(createMemoryAuthRateLimitRepository()),
    credentialStuffing: createCredentialStuffingService(
      {
        maxAccountsPerIp: { count: 20, windowMs: 60_000 },
        maxIpsPerAccount: { count: 20, windowMs: 60_000 },
      },
      createMemoryCredentialStuffingRepository(),
    ),
    securityGate: {
      preAuthCheck: async () => ({ allowed: true }),
      lockoutCheck: async () => ({ allowed: true }),
      recordLoginFailure: async () => ({ stuffingNowBlocked: false }),
      recordLoginSuccess: async () => {},
    },
    queueFactory: null,
    repos: {
      oauthCode: createMemoryOAuthCodeRepository(),
      oauthReauth: createMemoryOAuthReauthRepository(),
      magicLink: createMemoryMagicLinkRepository(),
      deletionCancelToken: createMemoryDeletionCancelTokenRepository(),
      mfaChallenge: createMemoryMfaChallengeRepository(),
      samlRequestId: createMemorySamlRequestIdRepository(),
      verificationToken: createMemoryVerificationTokenRepository(),
      resetToken: createMemoryResetTokenRepository(),
      session: createMemorySessionRepository(),
    },
  };

  return { runtime, adminId: admin.id, memberId: member.id };
}

function createRouteAuth(adminId: string): RouteAuthRegistry {
  return {
    userAuth: async (c, next) => {
      const userId = c.req.header('x-user-id');
      if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const roles = userId === adminId ? ['admin'] : ['member'];
      c.set(
        'actor',
        Object.freeze({
          id: userId,
          kind: 'user' as const,
          tenantId: c.req.header('x-tenant-id') ?? null,
          sessionId: null,
          roles,
          claims: {},
        }),
      );
      return next();
    },
    bearerAuth: undefined,
    requireRole:
      (...requiredRoles: string[]) =>
      async (c, next) => {
        const actor = getActor(c);
        const roles = Array.isArray(actor.roles)
          ? actor.roles.filter((role): role is string => typeof role === 'string')
          : [];
        if (requiredRoles.some(role => roles.includes(role))) {
          return next();
        }
        return c.json({ error: 'Forbidden' }, 403);
      },
  };
}

function createPersistence(): SlingshotContext['persistence'] {
  const roomConfigs = new Map<string, { maxCount: number; ttlSeconds: number }>();
  let defaults = { maxCount: 100, ttlSeconds: 86_400 };

  return {
    uploadRegistry: {
      async register() {},
      async get() {
        return null;
      },
      async delete() {
        return false;
      },
    },
    idempotency: {
      async get() {
        return null;
      },
      async set() {},
      async clear() {},
    },
    wsMessages: {
      async persist(message) {
        return message;
      },
      async getHistory() {
        return [];
      },
      async clear() {},
    },
    auditLog: {
      async logEntry() {},
      async getLogs() {
        return { items: [] };
      },
    },
    cronRegistry: {
      async getAll() {
        return new Set<string>();
      },
      async save() {},
    },
    configureRoom(endpoint, room, options) {
      roomConfigs.set(`${endpoint}:${room}`, {
        maxCount: options.maxCount ?? defaults.maxCount,
        ttlSeconds: options.ttlSeconds ?? defaults.ttlSeconds,
      });
    },
    getRoomConfig(endpoint, room) {
      return roomConfigs.get(`${endpoint}:${room}`) ?? null;
    },
    setDefaults(nextDefaults) {
      defaults = {
        maxCount: nextDefaults.maxCount ?? defaults.maxCount,
        ttlSeconds: nextDefaults.ttlSeconds ?? defaults.ttlSeconds,
      };
    },
  };
}

function createSecretsRepository(): SlingshotContext['secrets'] {
  return {
    name: 'test-secrets',
    async get() {
      return null;
    },
    async getMany() {
      return new Map<string, string>();
    },
  };
}

function createMetricsState(): SlingshotContext['metrics'] {
  return {
    counters: new Map(),
    histograms: new Map(),
    gaugeCallbacks: new Map(),
    queues: null,
  };
}

function createTestContext(args: {
  app: Hono<AppEnv>;
  appName: string;
  bus: InProcessAdapter;
  frameworkConfig: SlingshotFrameworkConfig;
  pluginState: Map<string, unknown>;
  routeAuth: RouteAuthRegistry;
}): SlingshotContext {
  const config: SlingshotResolvedConfig = {
    appName: args.appName,
    resolvedStores: args.frameworkConfig.resolvedStores,
    security: args.frameworkConfig.security,
    signing: args.frameworkConfig.signing,
    dataEncryptionKeys: args.frameworkConfig.dataEncryptionKeys,
    redis: args.frameworkConfig.redis,
    mongo: args.frameworkConfig.mongo,
    captcha: args.frameworkConfig.captcha,
  };

  return {
    app: args.app,
    appName: args.appName,
    config,
    redis: null,
    mongo: null,
    sqlite: null,
    sqliteDb: null,
    signing: null,
    dataEncryptionKeys: [],
    ws: null,
    wsEndpoints: null,
    wsPublish: null,
    persistence: createPersistence(),
    pluginState: args.pluginState,
    publicPaths: new Set<string>(),
    plugins: [],
    bus: args.bus,
    routeAuth: args.routeAuth,
    actorResolver: null,
    identityResolver: createDefaultIdentityResolver(),
    rateLimitAdapter: null,
    fingerprintBuilder: null,
    cacheAdapters: new Map(),
    emailTemplates: new Map(),
    trustProxy: false,
    upload: null,
    metrics: createMetricsState(),
    secrets: createSecretsRepository(),
    resolvedSecrets: Object.freeze({}),
    async clear() {
      args.pluginState.clear();
    },
    async destroy() {
      args.pluginState.clear();
    },
  };
}

export interface OrgPluginTestHarness {
  app: Hono<AppEnv>;
  bus: InProcessAdapter;
  pluginState: Map<string, unknown>;
  frameworkConfig: SlingshotFrameworkConfig & { registeredEntities: ResolvedEntityConfig[] };
  adminId: string;
  memberId: string;
  pkg: SlingshotPackageDefinition;
  teardown(): Promise<void>;
}

/**
 * Drive the package + a manually mounted entity-plugin through their setup
 * lifecycles. This helper bypasses `createApp/compilePackages` so each
 * entity's `wiring.buildAdapter` (manual mode) is what populates the
 * package's closure-owned adapter refs. Mirrors the pattern in
 * `slingshot-polls/src/testing.ts`.
 */
export async function setupOrgPluginHarness(
  pluginConfig: OrganizationsPluginConfig = {
    organizations: { enabled: true, invitationTtlSeconds: 3600 },
    groups: { managementRoutes: true },
  },
): Promise<OrgPluginTestHarness> {
  const app = new Hono<AppEnv>();
  const bus = new InProcessAdapter();
  const frameworkConfig = createFrameworkConfig();
  const authRuntime = await createTestAuthRuntime(bus, frameworkConfig.resolvedStores);
  const pluginState = new Map<string, unknown>();
  pluginState.set('slingshot-auth', authRuntime.runtime);

  const routeAuth = createRouteAuth(authRuntime.adminId);
  attachContext(
    app,
    createTestContext({
      app,
      appName: 'organizations-test',
      bus,
      frameworkConfig,
      pluginState,
      routeAuth,
    }),
  );

  const pkg = createOrganizationsPackage(pluginConfig);

  // Manually mount the package's entity modules via `createEntityPlugin`.
  // Each `buildAdapter` here delegates to the corresponding entity module's
  // `wiring.buildAdapter`, which performs the per-entity adapter-transform
  // chain AND populates the package's closure-owned adapter refs. This is
  // the same dual-population pattern used in `slingshot-polls/src/testing.ts`.
  const entityEntries: EntityPluginEntry[] = pkg.entities.map(entityModule => {
    const impl = (entityModule as { implementation?: unknown }).implementation as {
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
        `[organizations test harness] expected manual wiring on entity '${entityModule.entityName}', got '${impl.wiring.mode}'`,
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
    name: 'slingshot-organizations',
    mountPath: pkg.mountPath ?? '',
    entities: entityEntries,
    middleware: pkg.middleware ? { ...pkg.middleware } : undefined,
  });

  const setupContext: PluginSetupContext = { app, bus, config: frameworkConfig };
  // Lifecycle order matches the framework path:
  //   1. package setupMiddleware     — resolves auth runtime + admin guards
  //   2. entity setupMiddleware      — entity-plugin policy hooks
  //   3. entity setupRoutes          — mounts CRUD + named-op routes (runs
  //                                    buildAdapter, populates package refs)
  //   4. package setupRoutes (none)  — organizations has no extra setupRoutes
  //   5. entity setupPost / package setupPost — capability/state publish
  await pkg.setupMiddleware?.(setupContext);
  await entityPlugin.setupMiddleware?.(setupContext);
  await entityPlugin.setupRoutes?.(setupContext);
  await pkg.setupRoutes?.(setupContext);
  await entityPlugin.setupPost?.(setupContext);
  await pkg.setupPost?.(setupContext);

  // `createApp` would do this; the test harness bypasses that path so we
  // manually publish the org service capability through plugin state for
  // legacy `getOrganizationsOrgServiceOrNull` consumers.
  for (const provider of pkg.capabilities.provides) {
    const value = await provider.resolve({ packageName: pkg.name });
    const slotKey = `slingshot:package:capabilities:${pkg.name}`;
    const existing = (pluginState.get(slotKey) as Record<string, unknown>) ?? {};
    pluginState.set(slotKey, Object.freeze({ ...existing, [provider.capability.name]: value }));
  }

  return {
    app,
    bus,
    pluginState,
    frameworkConfig,
    adminId: authRuntime.adminId,
    memberId: authRuntime.memberId,
    pkg,
    async teardown() {
      await pkg.teardown?.();
      await entityPlugin.teardown?.();
    },
  };
}
