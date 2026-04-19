import type {
  AuthCookieConfig,
  AccountDeletionConfig,
  AuthRateLimitConfig,
  AuthSessionPolicyConfig,
  BreachedPasswordConfig,
  ConcealRegistrationConfig,
  CsrfCookieConfig,
  EmailVerificationConfig,
  JwtConfig,
  MagicLinkConfig,
  MfaConfig,
  MfaEmailOtpConfig,
  MfaWebAuthnConfig,
  OidcConfig,
  PasswordResetConfig,
  PrimaryField,
  RefreshTokenConfig,
  SamlConfig,
  ScimConfig,
  StepUpConfig,
} from '@lastshotlabs/slingshot-auth';
import { buildContext, finalizeContext } from '@framework/buildContext';
import { validateAppConfig } from '@framework/config/schema';
import type { InfrastructureResult } from '@framework/createInfrastructure';
import { createInfrastructure } from '@framework/createInfrastructure';
import type { CaptchaConfig, CaptchaProvider } from '@framework/lib/captcha';
import { createMetricsState } from '@framework/metrics/registry';
import {
  mountCors,
  mountFrameworkMiddleware,
  mountTenantMiddleware,
} from '@framework/mountMiddleware';
import { mountOptionalEndpoints } from '@framework/mountOptionalEndpoints';
import { mountOpenApiDocs, mountRoutes } from '@framework/mountRoutes';
import { withSpan } from '@framework/otel/spans';
import { getTracer } from '@framework/otel/tracer';
import { ModelSchemasConfig, preloadModelSchemas } from '@framework/preloadSchemas';
import { registerBoundaryAdapters } from '@framework/registerBoundaryAdapters';
import { router as healthRouter } from '@framework/routes/health';
import { router as homeRouter } from '@framework/routes/home';
import {
  runPluginMiddleware,
  runPluginPost,
  runPluginRoutes,
  validateAndSortPlugins,
} from '@framework/runPluginLifecycle';
import { resolveSecretBundle } from '@framework/secrets';
import type { ResolvedSecretBundle } from '@framework/secrets';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { SigningConfig } from '@lib/signingConfig';
import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthConfig, OAuthConfig } from '@lastshotlabs/slingshot-auth';
import {
  HttpError,
  ValidationError,
  attachContext,
  createCoreRegistrar,
  defaultValidationErrorFormatter,
} from '@lastshotlabs/slingshot-core';
import type {
  AppEnv,
  CoreRegistrar,
  CoreRegistrarSnapshot,
  CsrfConfig,
  SlingshotContext,
  SlingshotEventBus,
  SlingshotPlugin,
  SlingshotRuntime,
} from '@lastshotlabs/slingshot-core';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { DbConfig } from './config/types/db';
import type { JobsConfig } from './config/types/jobs';
import type { LoggingConfig } from './config/types/logging';
import type { AppMeta } from './config/types/meta';
import type { MetricsConfig } from './config/types/metrics';
import type { ObservabilityConfig, TracingConfig } from './config/types/observability';
import type { PermissionsConfig } from './config/types/permissions';
import type { PluginsConfig } from './config/types/plugins';
import type { SecretsConfig } from './config/types/secrets';
import type { SecurityConfig } from './config/types/security';
import type { TenancyConfig } from './config/types/tenancy';
import type { UploadConfig } from './config/types/upload';
import type { ValidationConfig } from './config/types/validation';
import type { VersioningConfig } from './config/types/versioning';
import type { WsConfig } from './config/types/ws';

export type { SecretsConfig } from './config/types/secrets';
export type { PermissionsConfig } from './config/types/permissions';
export type { FrameworkSecretsLiteral } from '@framework/secrets';

export type { BreachedPasswordConfig };
export type { AuthRateLimitConfig };
// AuthConfig and OAuthConfig are now defined in @lastshotlabs/slingshot-auth and imported above.
// Re-export them for consumers that import from the framework root.
export type { AuthConfig, OAuthConfig };
export type { AccountDeletionConfig, AuthSessionPolicyConfig };
export type {
  PrimaryField,
  EmailVerificationConfig,
  PasswordResetConfig,
  RefreshTokenConfig,
  MfaConfig,
  MfaEmailOtpConfig,
  MfaWebAuthnConfig,
  SigningConfig,
  JwtConfig,
  StepUpConfig,
  OidcConfig,
  SamlConfig,
  ScimConfig,
  AuthCookieConfig,
  CsrfCookieConfig,
  ConcealRegistrationConfig,
  MagicLinkConfig,
};
export type { OrganizationsPluginConfig } from '@lastshotlabs/slingshot-organizations';
export type { CaptchaConfig, CaptchaProvider };
// CsrfConfig is now defined in @lastshotlabs/slingshot-core and imported above.
// Re-export for consumers that import from the framework root.
export type { CsrfConfig };
export type { ModelSchemasConfig } from '@framework/preloadSchemas';
export type { JobsConfig } from './config/types/jobs';
export type { PresignedUrlConfig, UploadConfig } from './config/types/upload';
export type { MetricsConfig } from './config/types/metrics';
export type { VersioningConfig } from './config/types/versioning';
export type { AppMeta } from './config/types/meta';
export type { DbConfig } from './config/types/db';
export type { BotProtectionConfig, SecurityConfig } from './config/types/security';
export type { TenancyConfig, TenantConfig } from './config/types/tenancy';
export type { LoggingConfig } from './config/types/logging';
export type { ValidationConfig } from './config/types/validation';
export type { ObservabilityConfig, TracingConfig } from './config/types/observability';
export { createChildSpan } from '@framework/otel/spans';

export interface CreateAppConfig<T extends object = object> {
  /** Absolute path to the service's routes directory (use import.meta.dir + "/routes"). Optional — omit when all routes are registered via plugins. */
  routesDir?: string;
  /**
   * Shared Zod schema sources. Files are imported before route discovery so schemas
   * are registered before any route references them.
   * Accepts a directory path, an array of paths/globs, or a full ModelSchemasConfig object.
   * Shorthand string/array defaults to registration: "auto".
   */
  modelSchemas?: string | string[] | ModelSchemasConfig;
  /** App name and version for the root endpoint and OpenAPI docs */
  meta?: AppMeta;
  /** Security: CORS, rate limiting, trust-proxy, signing, captcha */
  security?: SecurityConfig;
  /** Extra middleware injected after plugin middleware, before route matching */
  middleware?: MiddlewareHandler<AppEnv>[];
  /** Database connection and store routing configuration */
  db?: DbConfig;
  /** Job status endpoint configuration. Requires BullMQ + Redis. */
  jobs?: JobsConfig;
  /** Multi-tenancy configuration. When set, tenant middleware resolves tenant on each request. */
  tenancy?: TenancyConfig;
  /** Structured request logging configuration. Replaces Hono's built-in text logger. */
  logging?: LoggingConfig;
  /** Prometheus-compatible /metrics endpoint. Opt-in. */
  metrics?: MetricsConfig;
  /** Observability configuration: distributed tracing via OpenTelemetry. */
  observability?: ObservabilityConfig;
  /** Zod validation error formatting configuration. */
  validation?: ValidationConfig;
  /** File upload configuration. When set, registers storage adapter and upload settings. */
  upload?: UploadConfig;
  /**
   * API versioning configuration. When set, routes are discovered per-version from
   * subdirectories of `routesDir` (e.g. `routes/v1/`, `routes/v2/`). Each version
   * gets its own OpenAPI spec at `/{version}/openapi.json` and Scalar docs at
   * `/{version}/docs`. Root `/docs` becomes a version selector.
   */
  versioning?: VersioningConfig | string[];
  /**
   * Optional plugins to mount alongside the framework. Each plugin's setup() is called
   * after all framework middleware is registered, in dependency order.
   */
  plugins?: PluginsConfig;
  /**
   * Event bus for cross-plugin communication. Defaults to an in-process EventEmitter adapter.
   */
  eventBus?: SlingshotEventBus;
  /**
   * Optional WebSocket bootstrap configuration forwarded into app assembly so plugins can
   * self-wire endpoint handlers before `createServer()` starts the transport.
   */
  ws?: WsConfig<T>;
  /**
   * Secret provider for resolving credentials, API keys, and signing secrets.
   *
   * The framework will request the following keys based on your `db` config:
   *
   *   Always:
   *     JWT_SECRET, SLINGSHOT_DATA_ENCRYPTION_KEY
   *
   *   db.redis !== false (default: true):
   *     REDIS_HOST (required), REDIS_USER, REDIS_PASSWORD (optional)
   *
   *   db.mongo === 'single' (default):
   *     MONGO_USER, MONGO_PASSWORD, MONGO_HOST, MONGO_DB (required)
   *
   *   db.mongo === 'separate':
   *     above + MONGO_AUTH_USER, MONGO_AUTH_PASSWORD, MONGO_AUTH_HOST, MONGO_AUTH_DB
   *
   *   db.mongo === false:
   *     no MongoDB secrets
   *
   * Providers:
   *   - Omit: defaults to env provider (reads process.env / .env)
   *   - SecretRepository instance: full control
   *   - `{ provider: 'env', prefix?: string }` — environment variables
   *   - `{ provider: 'ssm', pathPrefix: string, region?: string }` — AWS SSM Parameter Store
   *   - `{ provider: 'file', directory: string }` — Docker/K8s file-based secrets
   */
  secrets?: SecretsConfig;
  /**
   * Runtime abstraction. Defaults to the Bun runtime when not provided.
   * Pass a Node.js runtime to run the framework outside of Bun.
   */
  runtime?: SlingshotRuntime;
  /**
   * Server-level permissions bootstrap. When set, the framework creates a
   * shared `PermissionsAdapter`, `PermissionRegistry`, and `PermissionEvaluator`
   * from the existing infra connection, available to all plugins via
   * `ctx.pluginState` at `PERMISSIONS_STATE_KEY`.
   *
   * Requires `@lastshotlabs/slingshot-permissions`.
   */
  permissions?: PermissionsConfig;
}

export interface CreateAppResult {
  app: OpenAPIHono<AppEnv>;
  ctx: SlingshotContext;
}

function mergeTenantExemptPaths(
  tenancy: TenancyConfig | undefined,
  plugins: readonly SlingshotPlugin[],
): TenancyConfig | undefined {
  if (!tenancy) return tenancy;

  const exemptPaths = new Set(tenancy.exemptPaths ?? []);
  for (const plugin of plugins) {
    for (const path of plugin.tenantExemptPaths ?? []) {
      exemptPaths.add(path);
    }
    for (const path of plugin.publicPaths ?? []) {
      exemptPaths.add(path);
    }
  }

  if (exemptPaths.size === (tenancy.exemptPaths?.length ?? 0)) return tenancy;

  return {
    ...tenancy,
    exemptPaths: [...exemptPaths],
  };
}

function mergeCsrfExemptPaths(
  security: SecurityConfig,
  plugins: readonly SlingshotPlugin[],
): SecurityConfig {
  const exemptPaths = new Set(security.csrf?.exemptPaths ?? []);
  for (const plugin of plugins) {
    for (const path of plugin.csrfExemptPaths ?? []) {
      exemptPaths.add(path);
    }
    for (const path of plugin.publicPaths ?? []) {
      exemptPaths.add(path);
    }
  }

  if (exemptPaths.size === (security.csrf?.exemptPaths?.length ?? 0)) {
    return security;
  }

  return {
    ...security,
    csrf: {
      ...(security.csrf ?? {}),
      exemptPaths: [...exemptPaths],
    },
  };
}

function freezeFrameworkSecurity(
  security: Readonly<{
    cors: string | readonly string[];
    csrf?: { exemptPaths?: string[]; disabled?: boolean };
  }>,
): Readonly<{
  cors: string | readonly string[];
  csrf?: { exemptPaths?: readonly string[]; disabled?: boolean };
}> {
  return Object.freeze({
    cors: security.cors,
    csrf: security.csrf
      ? Object.freeze({
          ...security.csrf,
          exemptPaths: security.csrf.exemptPaths
            ? Object.freeze([...security.csrf.exemptPaths])
            : undefined,
        })
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// Pipeline stage types — each phase takes the output of the previous one.
// The types enforce ordering: you can't call assembleApp without a Bootstrap.
// ---------------------------------------------------------------------------

interface AppBootstrap {
  bus: SlingshotEventBus;
  registrar: CoreRegistrar;
  drain: () => CoreRegistrarSnapshot;
  sortedPlugins: SlingshotPlugin[];
  appName: string;
  openApiVersion: string;
  securityConfig: SecurityConfig;
  secretBundle: ResolvedSecretBundle;
  infra: InfrastructureResult;
  runtime: SlingshotRuntime;
  tracingConfig: TracingConfig | undefined;
  isProd: boolean;
}

interface AppAssembly extends AppBootstrap {
  app: OpenAPIHono<AppEnv>;
  ctx: SlingshotContext;
  tenantCacheCarrier: {
    cache: import('@framework/middleware/tenant').TenantResolutionCache | null;
  };
}

async function cleanupBootstrapFailure(bootstrap: AppBootstrap): Promise<void> {
  try {
    await bootstrap.bus.shutdown?.();
  } catch {
    /* best-effort */
  }

  if (bootstrap.infra.redisEnabled && bootstrap.infra.redis) {
    try {
      const { disconnectRedis } = await import('@lib/redis');
      await disconnectRedis(bootstrap.infra.redis as import('ioredis').default | null);
    } catch {
      /* best-effort */
    }
  }

  if (bootstrap.infra.mongoMode !== false && bootstrap.infra.mongo) {
    try {
      const { disconnectMongo } = await import('@lib/mongo');
      await disconnectMongo(bootstrap.infra.mongo.auth, bootstrap.infra.mongo.app);
    } catch {
      /* best-effort */
    }
  }

  if (bootstrap.infra.sqliteDb) {
    try {
      bootstrap.infra.sqliteDb.close();
    } catch {
      /* best-effort */
    }
  }

  try {
    await bootstrap.secretBundle.provider.destroy?.();
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Phase 1: validate config, resolve secrets, connect infrastructure
// ---------------------------------------------------------------------------

async function prepareBootstrap<T extends object>(
  config: CreateAppConfig<T>,
): Promise<AppBootstrap> {
  const isProd = process.env.NODE_ENV === 'production';
  const tracingConfig = config.observability?.tracing?.enabled
    ? Object.freeze({ ...config.observability.tracing })
    : undefined;
  const tracer = getTracer(tracingConfig);

  await withSpan(tracer, 'slingshot.bootstrap.validate', () => {
    const { warnings } = validateAppConfig(config as unknown as Record<string, unknown>, {
      isProd,
    });
    for (const w of warnings) console.warn(w);
    return Promise.resolve();
  });

  const { meta: appConfig = {}, security: securityInput = {}, db = {} } = config;
  const securityConfig: SecurityConfig = {
    ...securityInput,
    signing: securityInput.signing ? { ...securityInput.signing } : undefined,
  };

  const plugins = config.plugins ?? [];
  const bus = config.eventBus ?? createInProcessAdapter();
  const coreReg = createCoreRegistrar();
  const { registrar } = coreReg;
  const drain = () => coreReg.drain();
  const sortedPlugins = validateAndSortPlugins(plugins);
  const appName = appConfig.name ?? 'Bun Core API';
  const openApiVersion = appConfig.version ?? '1.0.0';

  const secretBundle = await withSpan(tracer, 'slingshot.bootstrap.secrets', async span => {
    const secretsType =
      config.secrets &&
      typeof config.secrets === 'object' &&
      'provider' in config.secrets &&
      typeof config.secrets.provider === 'string'
        ? config.secrets.provider
        : config.secrets && typeof config.secrets === 'object' && 'provider' in config.secrets
          ? 'custom'
          : 'env';
    span.setAttribute('slingshot.secret_provider', secretsType);
    return resolveSecretBundle(config.secrets);
  });
  const resolvedSecrets = secretBundle.framework;

  if (resolvedSecrets.jwtSecret && !securityConfig.signing?.secret) {
    securityConfig.signing = { ...securityConfig.signing, secret: resolvedSecrets.jwtSecret };
  }

  const runtime =
    config.runtime ?? (await import('@lastshotlabs/slingshot-runtime-bun')).bunRuntime();

  const infra = await withSpan(tracer, 'slingshot.bootstrap.infrastructure', async span => {
    span.setAttribute('slingshot.db.mongo', String(db.mongo ?? 'single'));
    span.setAttribute('slingshot.db.redis', db.redis !== false);
    return createInfrastructure({
      db,
      securitySigning: securityConfig.signing,
      cors: securityConfig.cors,
      captcha: securityConfig.captcha,
      csrf: securityConfig.csrf,
      trustProxy: securityConfig.trustProxy,
      ws: config.ws,
      registrar,
      secrets: resolvedSecrets,
      uploadRegistryTtlSeconds: config.upload?.registryTtlSeconds,
      runtime,
    });
  });

  return {
    bus,
    registrar,
    drain,
    sortedPlugins,
    appName,
    openApiVersion,
    securityConfig,
    secretBundle,
    infra,
    runtime,
    tracingConfig,
    isProd,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: create Hono app + context, mount framework and plugin middleware
// ---------------------------------------------------------------------------

async function assembleApp<T extends object>(
  bootstrap: AppBootstrap,
  config: CreateAppConfig<T>,
  onContextCreated?: (ctx: SlingshotContext) => void,
): Promise<AppAssembly> {
  const { bus, registrar, sortedPlugins, appName, securityConfig, secretBundle, infra } = bootstrap;
  const { middleware = [] } = config;
  const tracer = getTracer(bootstrap.tracingConfig);

  const app = new OpenAPIHono<AppEnv>();
  const metricsState = createMetricsState();
  const tenantCacheCarrier = {
    cache: null as import('@framework/middleware/tenant').TenantResolutionCache | null,
  };

  const ctx: SlingshotContext = await withSpan(tracer, 'slingshot.bootstrap.context', async () => {
    const slingshotCtx = await buildContext({
      app,
      appName,
      infra,
      signing: securityConfig.signing,
      captcha: securityConfig.captcha,
      upload: config.upload,
      metricsState,
      plugins: bootstrap.sortedPlugins,
      bus,
      secretBundle,
      permissions: config.permissions,
    });
    onContextCreated?.(slingshotCtx);
    attachContext(app, slingshotCtx);
    return slingshotCtx;
  });

  // CORS must run before tenant so error responses from tenant resolution
  // (missing/invalid header) still carry CORS headers the browser can read.
  mountCors(app, securityConfig, config.tenancy, bootstrap.isProd);

  // Tenant resolution runs before framework middleware so tenantId is available for rate limiting.
  const tenantConfig = mergeTenantExemptPaths(config.tenancy, sortedPlugins);
  if (tenantConfig) {
    await mountTenantMiddleware(app, tenantConfig, tenantCacheCarrier, bootstrap.isProd);
  }

  const mergedSecurity = mergeCsrfExemptPaths(securityConfig, sortedPlugins);
  infra.frameworkConfig.security = freezeFrameworkSecurity({
    ...infra.frameworkConfig.security,
    csrf: mergedSecurity.csrf ? { ...mergedSecurity.csrf } : undefined,
  });
  Object.freeze(infra.frameworkConfig);

  await withSpan(tracer, 'slingshot.bootstrap.middleware.framework', async () => {
    await mountFrameworkMiddleware(app, {
      security: mergedSecurity,
      logging: config.logging,
      metrics: config.metrics,
      metricsState,
      validation: config.validation,
      tracing: bootstrap.tracingConfig,
      isProd: bootstrap.isProd,
    });
  });

  // Register default boundary adapters (plugins may override during setupMiddleware)
  await withSpan(tracer, 'slingshot.bootstrap.middleware.boundary', async () => {
    await registerBoundaryAdapters(registrar, {
      redisEnabled: infra.redisEnabled,
      mongoMode: infra.mongoMode,
      redis: infra.redis,
      appConnection: infra.mongo?.app ?? null,
      sqliteDb: infra.sqliteDb,
      postgresPool: infra.postgres?.pool ?? null,
    });
  });

  // Plugin middleware phase — after framework rate limiting, before user middleware.
  await withSpan(tracer, 'slingshot.bootstrap.middleware.plugins', async () => {
    await runPluginMiddleware(sortedPlugins, app, infra.frameworkConfig, bus, tracer);
  });
  for (const mw of middleware) app.use(mw);

  return { ...bootstrap, app, ctx, tenantCacheCarrier };
}

// ---------------------------------------------------------------------------
// Phase 3: preload schemas, mount plugin + core + service routes, error handlers
// ---------------------------------------------------------------------------

async function mountAppRoutes<T extends object>(
  assembly: AppAssembly,
  config: CreateAppConfig<T>,
): Promise<void> {
  const { app, sortedPlugins, appName, openApiVersion, secretBundle, infra, bus, runtime } =
    assembly;
  const tracer = getTracer(assembly.tracingConfig);

  // Schema pre-loading before routes so registerSchema calls run first ($ref not inline).
  await withSpan(tracer, 'slingshot.bootstrap.schemas', async () => {
    await preloadModelSchemas(config.modelSchemas, runtime.glob);
  });

  // Plugin routes — after tenant/user middleware, before framework routes.
  await withSpan(tracer, 'slingshot.bootstrap.routes.plugins', async () => {
    await runPluginRoutes(sortedPlugins, app, infra.frameworkConfig, bus, tracer);
  });

  // Core framework routes (health, home).
  await withSpan(tracer, 'slingshot.bootstrap.routes.core', () => {
    app.route('/', healthRouter);
    app.route('/', homeRouter);

    mountOptionalEndpoints(
      app,
      config.jobs,
      config.metrics,
      config.upload,
      assembly.ctx.metrics,
      secretBundle.framework,
      assembly.isProd,
      infra.postgres,
    );
    return Promise.resolve();
  });

  const { routesDir } = config;
  if (routesDir) {
    await withSpan(tracer, 'slingshot.bootstrap.routes.service', async () => {
      await mountRoutes(app, routesDir, config.versioning, appName, openApiVersion, runtime.glob);
    });
  } else {
    // No routesDir (manifest-driven or plugin-only apps) — still register
    // the OpenAPI spec and Scalar docs so /openapi.json and /docs are reachable.
    mountOpenApiDocs(app, appName, openApiVersion);
  }

  app.onError((err, c) => {
    const reqId = c.get('requestId');
    // ValidationError extends HttpError — must check first or the details payload is lost
    if (err instanceof ValidationError) {
      const fmt = c.get('validationErrorFormatter');
      try {
        return c.json(fmt(err.issues, reqId), 400);
      } catch {
        return c.json(defaultValidationErrorFormatter(err.issues, reqId), 400);
      }
    }
    if (err instanceof HttpError) {
      const body: Record<string, unknown> = { error: err.message, requestId: reqId };
      if (err.code !== undefined) body.code = err.code;
      return c.json(body, err.status as ContentfulStatusCode);
    }
    console.error(err);
    return c.json({ error: 'Internal Server Error', requestId: reqId }, 500);
  });

  app.notFound(c => c.json({ error: 'Not Found', requestId: c.get('requestId') }, 404));
}

// ---------------------------------------------------------------------------
// Phase 4: plugin post phase, drain registrar into context, emit ready
// NOT for routes/middleware — would be invisible to OpenAPI / unreachable by onError.
// ---------------------------------------------------------------------------

async function finalizeApp(assembly: AppAssembly): Promise<CreateAppResult> {
  const { app, ctx, sortedPlugins, bus, drain, tenantCacheCarrier, infra } = assembly;
  const tracer = getTracer(assembly.tracingConfig);

  await withSpan(tracer, 'slingshot.bootstrap.post', async () => {
    await runPluginPost(sortedPlugins, app, infra.frameworkConfig, bus, tracer);
  });

  await withSpan(tracer, 'slingshot.bootstrap.finalize', () => {
    finalizeContext(ctx, drain());

    if (tenantCacheCarrier.cache) {
      ctx.pluginState.set('tenantResolutionCache', tenantCacheCarrier.cache);
    }
    if (sortedPlugins.length > 0) {
      bus.emit('app:ready', { plugins: sortedPlugins.map(p => p.name) });
    }
    return Promise.resolve();
  });

  return { app, ctx };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export const createApp = async <T extends object = object>(
  config: CreateAppConfig<T>,
): Promise<CreateAppResult> => {
  const tracingConfig = config.observability?.tracing?.enabled
    ? Object.freeze({ ...config.observability.tracing })
    : undefined;
  const tracer = getTracer(tracingConfig);

  return withSpan(tracer, 'slingshot.bootstrap', async span => {
    span.setAttribute('slingshot.app_name', config.meta?.name ?? 'unknown');
    let bootstrap: AppBootstrap | null = null;
    let assembly: AppAssembly | null = null;
    const partialContextCarrier = { ctx: null as SlingshotContext | null };

    try {
      bootstrap = await prepareBootstrap(config);
      assembly = await assembleApp(bootstrap, config, ctx => {
        partialContextCarrier.ctx = ctx;
      });
      await mountAppRoutes(assembly, config);
      const result = await finalizeApp(assembly);
      partialContextCarrier.ctx = null;
      return result;
    } catch (error) {
      if (assembly?.ctx) {
        await assembly.ctx.destroy().catch(() => {});
      } else if (partialContextCarrier.ctx) {
        await partialContextCarrier.ctx.destroy().catch(() => {});
      } else if (bootstrap) {
        await cleanupBootstrapFailure(bootstrap);
      }
      throw error;
    }
  });
};
