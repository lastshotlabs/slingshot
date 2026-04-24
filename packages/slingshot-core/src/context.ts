import { OpenAPIHono, type OpenAPIHonoOptions } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { z } from 'zod';
import type { SlingshotContext } from './context/slingshotContext';
import type { Actor } from './identity';
import type { UploadResult } from './storageAdapter';

/**
 * A single field-level validation error detail produced by the default formatter.
 */
export interface ValidationErrorDetail {
  /** Dot-joined path to the failing field (e.g. `'user.email'`). */
  path: string;
  /** Human-readable validation message (from the Zod issue). */
  message: string;
}

/**
 * The response body shape produced by `defaultValidationErrorFormatter`.
 * Clients can use `details` for per-field error display and `requestId` for support.
 */
export interface DefaultValidationErrorBody {
  /** Comma-joined summary of all validation messages. */
  error: string;
  /** Per-field error details. */
  details: ValidationErrorDetail[];
  /** The request ID for this failed request (from `x-request-id`). */
  requestId: string;
}

/**
 * A function that converts Zod issues into a custom validation error response body.
 *
 * Override this in your app config to control the shape of 400 validation errors.
 * The default is `defaultValidationErrorFormatter` which produces `DefaultValidationErrorBody`.
 *
 * @param issues - The Zod issues from a failed parse.
 * @param requestId - The current request ID for correlation.
 * @returns Any JSON-serialisable value to send as the 400 response body.
 *
 * @remarks
 * If the formatter throws, `defaultHook` catches the error and falls back to
 * `defaultValidationErrorFormatter` automatically — a buggy custom formatter will not
 * cause a 500. The formatter must be synchronous; async formatters are not supported.
 */
export type ValidationErrorFormatter = (issues: z.core.$ZodIssue[], requestId: string) => unknown;

/**
 * The built-in Zod validation error formatter used by `defaultHook`.
 *
 * Produces `{ error, details, requestId }` where `details` is a per-field breakdown.
 * Assign `config.validationErrorFormatter` in your app config to replace this with
 * a custom formatter that matches your API's error contract.
 *
 * @param issues - The Zod issues from a failed parse.
 * @param requestId - The current request ID.
 * @returns A `DefaultValidationErrorBody` with per-field error details.
 *
 * @remarks
 * This function never throws. It is also the automatic fallback inside `defaultHook`
 * when a custom `ValidationErrorFormatter` throws — so overriding it is safe to do
 * without worrying about breaking the fallback path.
 */
export const defaultValidationErrorFormatter: ValidationErrorFormatter = (
  issues: z.core.$ZodIssue[],
  requestId: string,
): DefaultValidationErrorBody => {
  const error = issues.map(i => i.message).join(', ');
  const details: ValidationErrorDetail[] = issues.map(i => ({
    path: i.path.join('.'),
    message: i.message,
  }));
  return { error, details, requestId };
};

/**
 * The Hono context variable bag set by framework middleware on every request.
 *
 * These variables are accessible via `c.get('variableName')` in route handlers.
 * They are populated by the framework before any plugin or user route runs.
 */
export type AppVariables = {
  /**
   * Unique identifier for this request, echoed in error responses and logs.
   *
   * @remarks
   * Set by the `requestId` middleware at the very start of the request pipeline,
   * before any plugin middleware runs. Always non-null inside route handlers.
   */
  requestId: string;
  /**
   * The resolved tenant ID for multi-tenant apps, or `null` for single-tenant.
   *
   * @remarks
   * Set by the tenant middleware after `setupMiddleware` but before `setupRoutes`.
   * `null` in single-tenant mode or when tenant resolution finds no match for the
   * current request (behavior depends on the tenancy plugin's miss strategy).
   */
  tenantId: string | null;
  /**
   * Tenant-specific configuration object, or `null` when not in multi-tenant mode.
   *
   * @remarks
   * Set alongside `tenantId` by the tenant middleware. The shape is plugin-defined —
   * cast to the tenancy plugin's config type at use sites. `null` in single-tenant apps
   * or when no tenant config was found for the resolved `tenantId`.
   */
  tenantConfig: Record<string, unknown> | null;
  /**
   * Validation error formatter — controls the 400 response shape for Zod failures.
   *
   * @remarks
   * Set by the framework from `config.validationErrorFormatter` before routes run.
   * Falls back to `defaultValidationErrorFormatter` when no custom formatter is configured.
   * The `defaultHook` reads this variable on every validation failure.
   */
  validationErrorFormatter: ValidationErrorFormatter;
  /**
   * Collected upload results for the current request, or `null` when no upload
   * middleware is active for this route.
   *
   * @remarks
   * Populated by the upload middleware after it processes multipart fields. Access
   * this in route handlers that accept file uploads to get the resolved storage URLs
   * and metadata for each uploaded file.
   */
  uploadResults: UploadResult[] | null;
  /**
   * The upload bucket name targeted by this request, or `undefined` when no upload
   * middleware is active for this route.
   *
   * @remarks
   * Set by the upload middleware from the route's upload config. `undefined` on routes
   * that do not declare an upload bucket.
   */
  uploadBucket: string | undefined;
  /**
   * The instance-scoped `SlingshotContext` for this app, set by the context middleware.
   *
   * @remarks
   * Always non-null inside route handlers — the context middleware runs before every
   * plugin and user route and throws if the context cannot be resolved. Use
   * `getSlingshotCtx(c)` as a typed convenience wrapper rather than calling `c.get('slingshotCtx')`
   * directly.
   */
  slingshotCtx: SlingshotContext;
  /**
   * The resolved request actor, or `null` before actor resolution runs.
   *
   * @remarks
   * Published by the framework actor-resolution middleware after auth and tenant
   * context are available. Downstream code should prefer `getActor(c)`,
   * `getActorId(c)`, and `getActorTenantId(c)` over reading legacy auth
   * variables directly.
   */
  actor: Actor | null;
  /**
   * The active OpenTelemetry span for this request, or `undefined` when
   * tracing is not enabled.
   *
   * @remarks
   * Set by the OTel request middleware when `observability.tracing.enabled` is
   * true. Plugin authors can use this to create child spans via the
   * `createChildSpan` helper exported from the framework root.
   */
  otelSpan: import('@opentelemetry/api').Span | undefined;
  /**
   * The raw, already-verified JWT payload stashed by the identity middleware.
   *
   * @remarks
   * Set by `identify` after the token signature is verified. Contains all claims
   * from the JWT (e.g. `sub`, `sid`, `roles`, `azp`, `exp`, custom claims).
   * Typed `unknown` to avoid a hard dependency on the auth plugin's JWT payload
   * type in `slingshot-core`. `null` when unauthenticated or when only bearer auth
   * (not `identify`) ran.
   */
  tokenPayload: unknown;
};

/**
 * The Hono `Env` type for all Slingshot routers.
 *
 * Pass this as the generic parameter to `Hono`, `OpenAPIHono`, and `Context` to get
 * fully-typed access to request variables set by the framework middleware.
 *
 * @example
 * ```ts
 * import type { AppEnv } from '@lastshotlabs/slingshot-core';
 * import { Hono } from 'hono';
 *
 * const router = new Hono<AppEnv>();
 * router.get('/', (c) => {
 *   const { requestId, tenantId } = c.var; // fully typed
 *   return c.json({ requestId });
 * });
 * ```
 */
export type AppEnv = { Variables: AppVariables };

/**
 * The Hono `defaultHook` used by all `OpenAPIHono` routers created via `createRouter()`.
 *
 * Intercepts Zod validation failures from `@hono/zod-openapi` and returns a structured
 * 400 response using the request's configured `validationErrorFormatter`. Falls back to
 * `defaultValidationErrorFormatter` if the formatter throws.
 *
 * @remarks
 * If the custom `validationErrorFormatter` itself throws (e.g., due to a bug in a user's
 * formatter), `defaultHook` silently catches the error and retries with
 * `defaultValidationErrorFormatter`. This means a broken custom formatter will degrade
 * to the default shape rather than producing an unhandled 500 error.
 */
export const defaultHook: NonNullable<OpenAPIHonoOptions<AppEnv>['defaultHook']> = (result, c) => {
  if (!result.success) {
    const requestIdValue = c.get('requestId') as unknown;
    const requestId = typeof requestIdValue === 'string' ? requestIdValue : 'unknown';
    const formatterValue = c.get('validationErrorFormatter') as unknown;
    const formatter: ValidationErrorFormatter =
      typeof formatterValue === 'function'
        ? (formatterValue as ValidationErrorFormatter)
        : defaultValidationErrorFormatter;
    try {
      return c.json(formatter(result.error.issues, requestId), 400);
    } catch {
      return c.json(defaultValidationErrorFormatter(result.error.issues, requestId), 400);
    }
  }
};

/**
 * Create a new `OpenAPIHono` router pre-configured with the Slingshot `AppEnv` type
 * and the shared `defaultHook` for validation error handling.
 *
 * All plugin and framework routes use this factory so that error formatting and
 * context variable typing are consistent across the entire application.
 *
 * @returns A new `OpenAPIHono<AppEnv>` instance.
 *
 * @remarks
 * Use `createRouter()` (not `new Hono()` or `new OpenAPIHono()`) for any router that:
 * - Declares OpenAPI routes via `router.openapi(createRoute(...), handler)`
 * - Needs access to typed `AppVariables` (requestId, tenantId, slingshotCtx, etc.)
 * - Should participate in the shared `defaultHook` validation error pipeline
 *
 * A plain `new Hono()` is acceptable for middleware-only routers that never call
 * `c.get('slingshotCtx')` or declare OpenAPI routes.
 *
 * @example
 * ```ts
 * import { createRouter, createRoute } from '@lastshotlabs/slingshot-core';
 *
 * const router = createRouter();
 * router.openapi(createRoute({ method: 'get', path: '/health', responses: { ... } }), (c) => {
 *   return c.json({ ok: true });
 * });
 * ```
 */
export const createRouter = () => new OpenAPIHono<AppEnv>({ defaultHook });

/**
 * Retrieve the `SlingshotContext` from a Hono request context.
 *
 * The context variable `slingshotCtx` is set by the framework's context middleware
 * on every request. Use this in route handlers when you need access to instance-scoped
 * state (persistence, plugins, event bus, secrets, etc.).
 *
 * @param c - The Hono request context (typed to `AppEnv`).
 * @returns The `SlingshotContext` for this app instance.
 * @throws If the `slingshotCtx` variable is not set — the request is not flowing through
 *   a Slingshot-managed app, or `createApp()` was not called.
 *
 * @remarks
 * **Timing:** safe to call inside any route handler, error handler, or response middleware
 * that runs after the framework's context middleware. Do NOT call it in constructor-time
 * code, module-level code, or plugin setup phases — `slingshotCtx` is a per-request
 * variable that only exists within the Hono request pipeline. For access outside a
 * request, use `getContext(app)` from the framework layer instead.
 *
 * @example
 * ```ts
 * import { getSlingshotCtx } from '@lastshotlabs/slingshot-core';
 *
 * router.openapi(myRoute, async (c) => {
 *   const ctx = getSlingshotCtx(c);
 *   const apiKey = await ctx.secrets.get('EXTERNAL_API_KEY');
 *   return c.json({ ok: true });
 * });
 * ```
 */
export function getSlingshotCtx(c: Context<AppEnv>): SlingshotContext {
  return c.get('slingshotCtx');
}
