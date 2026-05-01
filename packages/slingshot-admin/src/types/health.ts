/**
 * Aggregated health snapshot for `slingshot-admin`.
 *
 * `slingshot-admin` does not own a database or cache; this snapshot reflects
 * configured providers without performing I/O.
 */
export interface AdminPluginHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly details: {
    /** `true` when an `AuditLogProvider` was passed to `createAdminPlugin`. */
    readonly auditLogConfigured: boolean;
    /** `true` when a custom `AdminRateLimitStore` was passed. */
    readonly rateLimitStoreConfigured: boolean;
    /** `true` when a `MailRenderer` was passed. */
    readonly mailRendererConfigured: boolean;
    /** Mount path for admin routes. */
    readonly mountPath: string;
  };
}
