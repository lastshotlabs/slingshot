import { createAuditLogProvider } from '@framework/auditLog';
import type { AuditLogOptions } from '@framework/auditLog';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, AuditLogEntry, AuditLogProvider } from '@lastshotlabs/slingshot-core';
import { getActor, getClientIp, getRequestTenantId } from '@lastshotlabs/slingshot-core';

export interface AuditLogMiddlewareOptions extends AuditLogOptions {
  provider?: AuditLogProvider;
  exclude?: {
    /** Skip logging for requests with these HTTP methods (e.g. `["GET", "HEAD"]`). */
    methods?: string[];
    /**
     * Skip logging for requests whose path matches any entry.
     * Note: if this array grows large, regex evaluation on every request adds up.
     * For high-traffic exclusions, prefer string matching over regex.
     */
    paths?: (string | RegExp)[];
  };
  /**
   * Called after the entry is built, before it is written to storage.
   * Use to add semantic context: `action`, `resource`, `resourceId`, `meta`, or `expiresAt`.
   * If this hook throws, the error is logged and the original entry is written as-is.
   */
  onEntry?: (entry: AuditLogEntry, c: Context<AppEnv>) => AuditLogEntry | Promise<AuditLogEntry>;
}

/**
 * Hono middleware that records an audit log entry for every HTTP request.
 *
 * The entry is written **after** the route handler resolves, so `c.res.status` is
 * available.  Exclusion checks (method and path filters) run at the same point —
 * the route still executes; only the log write is skipped.
 *
 * The write is fire-and-forget: it never blocks or delays the response, and any
 * write failure is swallowed internally (logged via `console.error`).
 *
 * @param options - Configuration for the audit log middleware.  See
 *   {@link AuditLogMiddlewareOptions} for all available fields.
 * @returns A Hono `MiddlewareHandler` that can be registered with `app.use()`.
 *
 * @example
 * ```ts
 * app.use(auditLog({
 *   store: 'mongo',
 *   exclude: {
 *     methods: ['GET', 'HEAD'],
 *     paths: ['/health', /^\/docs/],
 *   },
 *   onEntry: (entry, c) => ({
 *     ...entry,
 *     action: 'api.request',
 *     resource: c.req.path,
 *   }),
 * }));
 * ```
 */
export const auditLog = (options: AuditLogMiddlewareOptions): MiddlewareHandler<AppEnv> => {
  const provider = options.provider ?? createAuditLogProvider(options);
  return async (c, next) => {
    await next();

    // Exclusion checks run after next() intentionally — c.res.status is only available
    // after the route handler runs. The route still executes; we're only skipping the log write.
    if (options.exclude?.methods?.includes(c.req.method)) return;

    // Note: if exclude.paths grows large, regex evaluation on every request adds up.
    // For high-traffic exclusions, prefer string matching over regex.
    const path = c.req.path;
    if (options.exclude?.paths?.some(p => (typeof p === 'string' ? p === path : p.test(path))))
      return;
    const actor = getActor(c);

    let entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      requestId: c.get('requestId'),
      userId: actor.id,
      sessionId: actor.sessionId,
      requestTenantId: getRequestTenantId(c),
      method: c.req.method,
      path,
      status: c.res.status,
      ip: getClientIp(c),
      userAgent: c.req.header('user-agent') ?? null,
      createdAt: new Date().toISOString(),
    };

    if (options.onEntry) {
      try {
        entry = await options.onEntry(entry, c);
      } catch (err) {
        console.error('[auditLog] onEntry hook threw:', err);
      }
    }

    // Fire-and-forget — never block the response; logAuditEntry also swallows errors internally
    provider.logEntry(entry).catch((err: unknown) => {
      console.error('[auditLog] write failed:', err);
    });
  };
};
