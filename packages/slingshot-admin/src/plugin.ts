import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AppEnv, PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { validateAdapterShape, validatePluginConfig } from '@lastshotlabs/slingshot-core';
import { createAdminRouter } from './routes/admin';
import { createMailRouter } from './routes/mail';
import { createPermissionsRouter } from './routes/permissions';
import type { AdminPluginConfig } from './types/config';
import { adminPluginConfigSchema } from './types/config';
import type { AdminEnv } from './types/env';

/**
 * Aggregated health snapshot for `slingshot-admin`.
 *
 * `slingshot-admin` does not own a database or cache — this snapshot reflects
 * the configuration of injected providers without performing any I/O. A
 * higher-level health endpoint should aggregate the audit-log and rate-limit
 * providers' own health snapshots when those exist.
 *
 * `status` is derived from the underlying signals:
 *   - `'unhealthy'` when no audit-log provider is configured (admin actions
 *     would not be recorded).
 *   - `'degraded'` when no rate-limit store is configured (the in-process
 *     default is single-instance only).
 *   - `'healthy'` when both providers are configured.
 */
export interface AdminPluginHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly details: {
    /** `true` when an `AuditLogProvider` was passed to `createAdminPlugin`. */
    readonly auditLogConfigured: boolean;
    /** `true` when a custom `AdminRateLimitStore` was passed (otherwise the in-process default is used). */
    readonly rateLimitStoreConfigured: boolean;
    /** `true` when a `MailRenderer` was passed. */
    readonly mailRendererConfigured: boolean;
    /** Mount path for admin routes (echoes the resolved config). */
    readonly mountPath: string;
  };
}

/**
 * Creates the Slingshot admin plugin, which mounts user-management, permissions,
 * and (optionally) mail-preview routes under a configurable path.
 *
 * All routes are protected by a single access-guard middleware that calls
 * `config.accessProvider.verifyRequest()`. The resolved principal is stored on
 * the Hono context as `adminPrincipal` for downstream handlers.
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
  const config = validatePluginConfig('slingshot-admin', rawConfig, adminPluginConfigSchema);

  // Validate adapter method shapes — Zod's z.custom() only checks non-null object;
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

  function doSetup({ app, bus }: PluginSetupContext): Promise<void> {
    const { accessProvider, managedUserProvider } = config;
    const mountPath = config.mountPath ?? '/admin';

    // Single auth guard protecting all routes under mountPath (admin, permissions, mail).
    // Placing the guard here rather than inside each sub-router ensures every
    // independently-mounted router is covered by the same access check.
    // Double-cast required: Hono<AppEnv> and Hono<AdminEnv> do not overlap in TS's
    // structural check because the context `set` method is contravariant. Safe because
    // AdminEnv only adds variables; AppEnv variables remain fully accessible.
    const adminApp = app as unknown as Hono<AdminEnv>;
    adminApp.use(`${mountPath}/*`, async (c: Context<AdminEnv>, next) => {
      // verifyRequest only reads HTTP headers — the contravariant context type
      // narrows AppEnv to AdminEnv at this provider boundary; cast is safe since
      // verifyRequest only consumes header data.
      const principal = await accessProvider.verifyRequest(c as unknown as Context<AppEnv>);
      if (!principal) return c.json({ error: 'Unauthorized' }, 401);
      c.set('adminPrincipal', principal);
      await next();
    });

    const adminRouter = createAdminRouter({
      managedUserProvider,
      bus,
      evaluator: config.permissions.evaluator,
      auditLog: config.auditLog,
      rateLimitStore: config.rateLimitStore,
    });
    app.route(mountPath, adminRouter);

    const permissionsRouter = createPermissionsRouter({
      evaluator: config.permissions.evaluator,
      adapter: config.permissions.adapter,
      registry: config.permissions.registry,
    });
    app.route(`${mountPath}/permissions`, permissionsRouter);

    if (config.mailRenderer) {
      const mailRouter = createMailRouter({
        renderer: config.mailRenderer,
        evaluator: config.permissions.evaluator,
      });
      app.route(mountPath, mailRouter);
    }

    return Promise.resolve();
  }

  const auditLogConfigured = config.auditLog != null;
  const rateLimitStoreConfigured = config.rateLimitStore != null;
  const mailRendererConfigured = config.mailRenderer != null;
  const resolvedMountPath = config.mountPath ?? '/admin';

  function getHealth(): AdminPluginHealth {
    let status: AdminPluginHealth['status'] = 'healthy';
    if (!auditLogConfigured) {
      status = 'unhealthy';
    } else if (!rateLimitStoreConfigured) {
      status = 'degraded';
    }
    return {
      status,
      details: {
        auditLogConfigured,
        rateLimitStoreConfigured,
        mailRendererConfigured,
        mountPath: resolvedMountPath,
      },
    };
  }

  return {
    name: 'slingshot-admin',
    dependencies: [],
    setupRoutes: doSetup,
    getHealth,
  };
}
