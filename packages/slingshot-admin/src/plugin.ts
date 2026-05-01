import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AppEnv, PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { validateAdapterShape, validatePluginConfig } from '@lastshotlabs/slingshot-core';
import { AdminCircuitOpenError, createAdminCircuitBreaker } from './lib/circuitBreaker';
import type { AdminCircuitBreaker } from './lib/circuitBreaker';
import { createAdminMetricsCollector } from './lib/metrics';
import type { AdminMetricsCollector } from './lib/metrics';
import { createAdminRouter } from './routes/admin';
import { createHealthRouter } from './routes/health';
import { createMailRouter } from './routes/mail';
import { createMetricsRouter } from './routes/metrics';
import { createPermissionsRouter } from './routes/permissions';
import type { AdminPluginConfig } from './types/config';
import { adminPluginConfigSchema } from './types/config';
import type { AdminEnv } from './types/env';
import type { AdminPluginHealth } from './types/health';

/**
 * Creates the Slingshot admin plugin, which mounts user-management, permissions,
 * and (optionally) mail-preview routes under a configurable path.
 *
 * All routes are protected by a single access-guard middleware that calls
 * `config.accessProvider.verifyRequest()`. The resolved principal is stored on
 * the Hono context as `adminPrincipal` for downstream handlers.
 *
 * **Circuit breaker:** The access provider is wrapped in a circuit breaker
 * (default: open after 5 consecutive failures, 30 s cooldown). When the breaker
 * is open, admin requests return 503 immediately instead of timing out against
 * a degraded upstream.
 *
 * **Health & metrics:** `GET <mountPath>/health` and `GET <mountPath>/metrics`
 * are mounted before the auth guard so monitoring systems can reach them.
 *
 * **Teardown:** Calls `teardown()` to reset internal counters and state.
 * Register this with your server's shutdown handler.
 *
 * @param rawConfig - Plugin configuration object. Validated with Zod at call
 *   time; invalid configs throw immediately so misconfiguration is caught before
 *   the server starts.
 * @returns A `SlingshotPlugin` to pass to `createApp()` / `createServer()`.
 *
 * @throws {Error} If `rawConfig` fails Zod validation or if any provider object
 *   is missing required methods (detected via `validateAdapterShape`).
 *
 * @example
 * ```ts
 * import { createAdminPlugin } from '@lastshotlabs/slingshot-admin';
 * import { createAuth0AccessProvider } from '@lastshotlabs/slingshot-admin';
 *
 * const adminPlugin = createAdminPlugin({
 *   accessProvider: createAuth0AccessProvider({
 *     domain: 'my-tenant.auth0.com',
 *     audience: 'https://api.myapp.com',
 *   }),
 *   managedUserProvider: authPlugin.getManagedUserProvider(),
 *   permissions: { evaluator, registry, adapter },
 * });
 * ```
 */
export function createAdminPlugin(
  rawConfig: AdminPluginConfig,
): SlingshotPlugin & { getHealth(): AdminPluginHealth } {
  const config = validatePluginConfig(
    'slingshot-admin',
    rawConfig,
    adminPluginConfigSchema,
  ) as unknown as AdminPluginConfig;

  // Validate adapter method shapes — Zod's per-field schemas check object shape;
  // these calls catch missing required methods at plugin creation time.
  validateAdapterShape('slingshot-admin', 'accessProvider', config.accessProvider, [
    'verifyRequest',
  ]);
  validateAdapterShape('slingshot-admin', 'managedUserProvider', config.managedUserProvider, [
    'listUsers',
    'getUser',
    'getCapabilities',
  ]);
  validateAdapterShape('slingshot-admin', 'permissions.evaluator', config.permissions.evaluator, [
    'can',
  ]);
  validateAdapterShape('slingshot-admin', 'permissions.registry', config.permissions.registry, [
    'getDefinition',
  ]);
  validateAdapterShape('slingshot-admin', 'permissions.adapter', config.permissions.adapter, [
    'createGrant',
  ]);

  // -------------------------------------------------------------------------
  // Circuit breaker — wraps the access provider so repeated failures trip it
  // open and requests fail-fast rather than hanging against a degraded upstream.
  // -------------------------------------------------------------------------
  const circuitBreaker: AdminCircuitBreaker = createAdminCircuitBreaker({
    threshold: 5,
    cooldownMs: 30_000,
    providerName: config.accessProvider.name ?? 'admin-provider',
  });

  // -------------------------------------------------------------------------
  // Metrics collector — in-memory counters for operational observability.
  // -------------------------------------------------------------------------
  const metricsCollector: AdminMetricsCollector = createAdminMetricsCollector();

  async function doSetup({ app, bus }: PluginSetupContext): Promise<void> {
    const { accessProvider, managedUserProvider } = config;
    const mountPath = config.mountPath ?? '/admin';

    // -----------------------------------------------------------------------
    // Health & metrics endpoints — mounted BEFORE the auth guard so monitoring
    // systems can reach them without admin credentials.
    // -----------------------------------------------------------------------
    const adminApp = app as unknown as Hono<AdminEnv>;

    const healthRouter = createHealthRouter({
      getPluginHealth: getHealth,
      getCircuitBreakerHealth: () => circuitBreaker.getHealth(),
      accessProviderName: config.accessProvider.name ?? 'unknown',
      managedUserProviderName: config.managedUserProvider.name ?? 'unknown',
    });
    app.route(mountPath, healthRouter as unknown as Hono<AppEnv>);

    const metricsRouter = createMetricsRouter({
      metricsCollector,
      getCircuitBreakerHealth: () => circuitBreaker.getHealth(),
    });
    app.route(mountPath, metricsRouter as unknown as Hono<AppEnv>);

    // -----------------------------------------------------------------------
    // Access guard — skip auth for health/metrics endpoints by checking path.
    // -----------------------------------------------------------------------
    adminApp.use(`${mountPath}/*`, async (c: Context<AdminEnv>, next) => {
      const path = c.req.path;

      // Allow health and metrics through without auth
      if (path.endsWith('/health') || path.endsWith('/metrics')) {
        await next();
        return;
      }

      metricsCollector.incrementRequestCount();
      let principal;
      try {
        principal = await circuitBreaker.guard(() =>
          accessProvider.verifyRequest(c as unknown as Context<AppEnv>),
        );
      } catch (err) {
        metricsCollector.incrementErrorCount();
        if (err instanceof AdminCircuitOpenError) {
          return c.json({ error: 'Service Unavailable' }, 503 as const);
        }
        throw err;
      }
      if (!principal) {
        metricsCollector.incrementErrorCount();
        return c.json({ error: 'Unauthorized' }, 401 as const);
      }
      c.set('adminPrincipal', principal);
      await next();
    });

    const adminRouter = createAdminRouter({
      managedUserProvider,
      bus,
      evaluator: config.permissions.evaluator,
      auditLog: config.auditLog,
      auditLogger: config.auditLogger,
      rateLimitStore: config.rateLimitStore,
      logger: config.logger,
    });
    app.route(mountPath, adminRouter);

    const permissionsRouter = createPermissionsRouter({
      evaluator: config.permissions.evaluator,
      adapter: config.permissions.adapter,
      registry: config.permissions.registry,
      auditLogger: config.auditLogger,
    });
    app.route(`${mountPath}/permissions`, permissionsRouter);

    if (config.mailRenderer) {
      const mailRouter = createMailRouter({
        renderer: config.mailRenderer,
        evaluator: config.permissions.evaluator,
        auditLogger: config.auditLogger,
      });
      app.route(mountPath, mailRouter);
    }
  }

  const auditLogConfigured = config.auditLog != null;
  const auditLoggerConfigured = config.auditLogger != null;
  const rateLimitStoreConfigured = config.rateLimitStore != null;
  const mailRendererConfigured = config.mailRenderer != null;
  const resolvedMountPath = config.mountPath ?? '/admin';

  function getHealth(): AdminPluginHealth {
    const cbHealth = circuitBreaker.getHealth();
    let status: AdminPluginHealth['status'] = 'healthy';
    if (!auditLogConfigured && !auditLoggerConfigured) {
      status = 'degraded';
    } else if (!rateLimitStoreConfigured) {
      status = 'degraded';
    } else if (cbHealth.state === 'open') {
      status = 'unhealthy';
    } else if (cbHealth.state === 'half-open') {
      status = 'degraded';
    }
    return {
      status,
      details: {
        auditLogConfigured,
        auditLoggerConfigured,
        rateLimitStoreConfigured,
        mailRendererConfigured,
        mountPath: resolvedMountPath,
        accessProviderName: config.accessProvider.name ?? 'unknown',
        circuitBreaker: cbHealth,
      },
    };
  }

  async function teardown(): Promise<void> {
    metricsCollector.reset();
  }

  return {
    name: 'slingshot-admin',
    dependencies: [],
    setupRoutes: doSetup,
    getHealth,
    teardown,
  };
}
