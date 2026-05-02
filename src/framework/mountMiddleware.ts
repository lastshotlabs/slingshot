/**
 * Middleware mounting — extracted from createApp().
 *
 * Handles the framework middleware stack: request ID, validation formatter,
 * metrics collection, request logging, secure headers, CORS, bot protection,
 * rate limiting, and tenant resolution.
 */
import type { LoggingConfig } from '@config/types/logging';
import type { MetricsConfig } from '@config/types/metrics';
import type { TracingConfig } from '@config/types/observability';
import type { SecurityConfig } from '@config/types/security';
import type { TenancyConfig } from '@config/types/tenancy';
import type { ValidationConfig } from '@config/types/validation';
import type { MetricsState } from '@framework/metrics/registry';
import { otelRequestMiddleware } from '@framework/middleware/otelRequest';
import { rateLimit } from '@framework/middleware/rateLimit';
import { requestId } from '@framework/middleware/requestId';
import { createRequestScopesMiddleware } from '@framework/middleware/requestScopes';
import { requestLogger } from '@framework/middleware/requestLogger';
import { getTracer, isTracingEnabled } from '@framework/otel/tracer';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import {
  HEADER_CSRF_TOKEN,
  HEADER_REFRESH_TOKEN,
  HEADER_REQUEST_ID,
  HEADER_USER_TOKEN,
  defaultValidationErrorFormatter,
} from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MountMiddlewareConfig {
  security: SecurityConfig;
  isProd: boolean;
  logging?: LoggingConfig;
  metrics?: MetricsConfig;
  metricsState?: MetricsState;
  validation?: ValidationConfig;
  /** Tracing configuration for OTel request spans. */
  tracing?: TracingConfig;
  middleware?: MiddlewareHandler<AppEnv>[];
  /**
   * User-defined request scopes from `defineApp({ requestScopes: [...] })`.
   * The middleware is mounted right after `requestId` so scopes are available
   * for the entire handler lifecycle.
   */
  requestScopes?: readonly import('@lastshotlabs/slingshot-core').RequestScope[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Mount all framework middleware on the Hono app in the correct order.
 *
 * Order:
 * 1. Request ID
 * 2. OTel request tracing (if enabled)
 * 3. Validation error formatter (context variable)
 * 4. Metrics collection (if enabled)
 * 5. Request logging (if enabled)
 * 6. Secure headers
 * 7. Custom security headers
 * 8. CORS
 * 9. Bot protection (if configured)
 * 10. Rate limiting
 *
 * Plugin middleware and tenant resolution are mounted separately
 * (after this function returns) to maintain correct ordering.
 *
 * @param app - The `OpenAPIHono` app instance to register middleware on.
 * @param config - Middleware configuration including security, logging, metrics,
 *   tenancy, validation, and any user-supplied middleware.
 * @returns A promise that resolves when all middleware has been registered.
 *   Dynamically imported middleware modules (`metricsCollector`, `botProtection`)
 *   are awaited before registration.
 */
export async function mountFrameworkMiddleware(
  app: OpenAPIHono<AppEnv>,
  config: MountMiddlewareConfig,
): Promise<void> {
  const securityConfig = config.security;
  const isProd = config.isProd;

  app.use(requestId);

  // Request scopes — mounted after requestId so the request-id is observable
  // from inside scope factories, but before anything that might want a
  // request-scoped resource (logging, tracing, handlers).
  if (config.requestScopes && config.requestScopes.length > 0) {
    app.use(createRequestScopesMiddleware(config.requestScopes));
  }

  // OTel request tracing (after requestId, before everything else)
  if (isTracingEnabled(config.tracing)) {
    app.use(otelRequestMiddleware({ tracer: getTracer(config.tracing) }));
  }

  // Set the validation error formatter on context so defaultHook and onError both pick it up
  const validationFormatter = config.validation?.formatError ?? defaultValidationErrorFormatter;
  app.use('*', async (c, next) => {
    c.set('validationErrorFormatter', validationFormatter);
    await next();
  });

  // Metrics collection middleware (before requestLogger so it captures all requests)
  if (config.metrics?.enabled) {
    const metricsAuth = config.metrics.auth ?? 'none';
    if (metricsAuth === 'none' && !config.metrics.unsafePublic) {
      if (isProd) {
        throw new Error(
          '[security] metrics.auth is required in production. Set metrics.auth or explicitly set unsafePublic: true with auth: "none".',
        );
      }
      console.warn(
        '[security] /metrics is enabled without auth. Configure metrics.auth for production.',
      );
    }
    const { metricsCollector } = await import('@framework/middleware/metrics');
    app.use(
      metricsCollector({
        state:
          config.metricsState ??
          (() => {
            throw new Error('metricsState is required when metrics are enabled');
          })(),
        excludePaths: config.metrics.excludePaths,
        normalizePath: config.metrics.normalizePath,
      }),
    );
  }

  // Request logging
  const loggingConfig = config.logging ?? {};
  if (loggingConfig.enabled !== false) {
    app.use(
      requestLogger({
        onLog: loggingConfig.onLog,
        level: loggingConfig.level,
        excludePaths: loggingConfig.excludePaths,
        excludeMethods: loggingConfig.excludeMethods,
      }),
    );
  }

  // Secure headers
  const headerOpts: Record<string, string> = {};
  if (securityConfig.headers?.contentSecurityPolicy) {
    headerOpts['Content-Security-Policy'] = securityConfig.headers.contentSecurityPolicy;
  }
  if (securityConfig.headers?.permissionsPolicy) {
    headerOpts['Permissions-Policy'] = securityConfig.headers.permissionsPolicy;
  }
  app.use(secureHeaders());
  if (Object.keys(headerOpts).length > 0) {
    app.use(async (c, next) => {
      await next();
      for (const [k, v] of Object.entries(headerOpts)) {
        c.res.headers.set(k, v);
      }
    });
  }

  // CORS is mounted separately via mountCors() before tenant middleware.

  // Bot protection
  const botCfg = securityConfig.botProtection ?? {};
  if ((botCfg.blockList?.length ?? 0) > 0) {
    const { botProtection } = await import('@framework/middleware/botProtection');
    app.use(botProtection({ blockList: botCfg.blockList }));
  }

  // Rate limiting
  const rlConfig = securityConfig.rateLimit ?? { windowMs: 60_000, max: 100 };
  app.use(rateLimit({ ...rlConfig, fingerprintLimit: botCfg.fingerprintRateLimit ?? false }));
}

/**
 * Mount tenant resolution middleware on the Hono app.
 *
 * Called **after** the plugin `setupMiddleware` phase so that auth plugins can
 * initialise before tenant context is available, but **before** route handlers
 * so that `c.get('tenantId')` and `c.get('tenantConfig')` are set for all routes.
 *
 * In production, `tenancy.onResolve` is required.  Without it, tenant IDs are
 * accepted without validation which is a cross-tenant data-access risk.  This
 * function throws in production if `onResolve` is absent and logs a warning in
 * development.
 *
 * @param app - The `OpenAPIHono` app instance to register the middleware on.
 * @param tenancy - Tenancy configuration.  See `TenancyConfig`.
 * @param carrier - Optional mutable carrier that will receive the created
 *   `TenantResolutionCache` instance for later invalidation.
 * @param isProd - Whether production-mode security checks are enforced.
 *   Defaults to `process.env.NODE_ENV === "production"`.
 * @returns A promise that resolves after the middleware is registered.
 * @throws {Error} In production when `tenancy.onResolve` is not provided.
 */
export async function mountTenantMiddleware(
  app: OpenAPIHono<AppEnv>,
  tenancy: TenancyConfig,
  carrier?: { cache: import('@framework/middleware/tenant').TenantResolutionCache | null },
  isProd = false,
): Promise<void> {
  if (!tenancy.onResolve) {
    if (isProd) {
      throw new Error(
        '[security] Tenancy is configured without an onResolve callback. ' +
          'In production, onResolve is required to validate tenant IDs and prevent cross-tenant access. ' +
          'Provide tenancy.onResolve or remove the tenancy config.',
      );
    } else {
      console.warn(
        '[security] Tenancy is configured without an onResolve callback — ' +
          'tenant IDs will be trusted without validation. This is unsafe in production.',
      );
    }
  }
  const { createTenantMiddleware } = await import('@framework/middleware/tenant');
  app.use(createTenantMiddleware(tenancy, carrier));
}

/**
 * Mount CORS middleware.
 *
 * Must be called BEFORE tenant middleware so that error responses from tenant
 * resolution (missing/invalid tenant header) still carry CORS headers and the
 * browser can read them.
 */
export function mountCors(
  app: OpenAPIHono<AppEnv>,
  security: SecurityConfig,
  tenancy?: TenancyConfig,
  isProd = false,
): void {
  const rawCors = security.cors ?? '*';
  const corsConfig =
    typeof rawCors === 'string' || Array.isArray(rawCors)
      ? {
          origin: rawCors,
          credentials: rawCors !== '*',
          allowHeaders: undefined as string[] | undefined,
          exposeHeaders: undefined as string[] | undefined,
          maxAge: undefined as number | undefined,
        }
      : {
          origin: rawCors.origin,
          credentials: rawCors.credentials ?? false,
          allowHeaders: rawCors.allowHeaders,
          exposeHeaders: rawCors.exposeHeaders,
          maxAge: rawCors.maxAge,
        };

  if (corsConfig.origin === '*' && isProd) {
    console.warn(
      '[security] CORS is set to wildcard (*) in production. Configure security.cors with specific origins to restrict cross-origin access.',
    );
  }

  const corsAllowHeaders = [
    'Content-Type',
    'Authorization',
    HEADER_USER_TOKEN,
    HEADER_REFRESH_TOKEN,
    HEADER_CSRF_TOKEN,
    ...(tenancy?.resolution === 'header' && tenancy.headerName ? [tenancy.headerName] : []),
  ];

  app.use(
    cors({
      origin: corsConfig.origin,
      allowHeaders: corsConfig.allowHeaders ?? corsAllowHeaders,
      exposeHeaders: corsConfig.exposeHeaders ?? ['x-cache', HEADER_REQUEST_ID],
      credentials: corsConfig.credentials,
      maxAge: corsConfig.maxAge,
    }),
  );
}
