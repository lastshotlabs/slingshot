import { z } from 'zod';
import type {
  AuditLogProvider,
  MailRenderer,
  PermissionEvaluator,
  PermissionRegistry,
  PermissionsAdapter,
} from '@lastshotlabs/slingshot-core';
import type { AdminAccessProvider, ManagedUserProvider } from '@lastshotlabs/slingshot-core';
import type { AdminRateLimitStore } from '../lib/rateLimitStore';

export interface AdminPermissionsConfig {
  evaluator: PermissionEvaluator;
  registry: PermissionRegistry;
  adapter: PermissionsAdapter;
}

/**
 * Configuration object for the Slingshot admin plugin.
 *
 * All provider fields map directly to injectable provider interfaces. The plugin
 * itself has no persistence of its own; storage is delegated to these providers.
 */
export interface AdminPluginConfig {
  mountPath?: string;
  accessProvider: AdminAccessProvider;
  managedUserProvider: ManagedUserProvider;
  mailRenderer?: MailRenderer;
  auditLog?: AuditLogProvider;
  rateLimitStore?: AdminRateLimitStore;
  permissions: AdminPermissionsConfig;
}

// ---------------------------------------------------------------------------
// Helper — minimal shape validation for provider methods
//
// Each provider is validated with `z.object({...}).passthrough()` so the schema
// confirms the value is a proper object whose required methods exist at
// parse time (not just a non-null object check). `passthrough()` allows
// additional methods beyond the minimum set.
//
// Required-method checks in `validateAdapterShape` (called in plugin.ts) still
// catch providers whose methods exist but have the wrong arity / signature.
// ---------------------------------------------------------------------------

/**
 * Minimal Zod schema for `AdminAccessProvider` — validates the shape at
 * config-parse time so misconfiguration is caught early.
 */
const AdminAccessProviderSchema = z
  .object({
    name: z.string().optional(),
    verifyRequest: z.function().output(z.promise(z.any())).optional(),
  })
  .passthrough();

/**
 * Minimal Zod schema for `ManagedUserProvider` — validates required methods.
 */
const ManagedUserProviderSchema = z
  .object({
    name: z.string().optional(),
    listUsers: z.function().output(z.promise(z.any())).optional(),
    getUser: z.function().output(z.promise(z.any())).optional(),
    getCapabilities: z.function().output(z.promise(z.any())).optional(),
  })
  .passthrough();

/**
 * Minimal Zod schema for a permissions sub-object (evaluator, registry, adapter).
 */
const PermissionEvaluatorSchema = z
  .object({
    name: z.string().optional(),
    can: z.function().output(z.promise(z.any())).optional(),
  })
  .passthrough();

const PermissionRegistrySchema = z
  .object({
    getDefinition: z.function().output(z.any()).optional(),
    listResourceTypes: z.function().output(z.any()).optional(),
  })
  .passthrough();

const PermissionsAdapterSchema = z
  .object({
    createGrant: z.function().output(z.promise(z.any())).optional(),
  })
  .passthrough();

const AdminRateLimitStoreSchema = z
  .object({
    hit: z.function().output(z.promise(z.any())).optional(),
  })
  .passthrough();

const AuditLogProviderSchema = z
  .object({
    logEntry: z.function().output(z.promise(z.any())).optional(),
    getLogs: z.function().output(z.promise(z.any())).optional(),
  })
  .passthrough();

const MailRendererSchema = z
  .object({
    name: z.string().optional(),
    render: z.function().output(z.promise(z.any())).optional(),
  })
  .passthrough();

function normalizeMountPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error("mountPath must start with '/'");
  }

  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized.length === 0) {
    throw new Error("mountPath must not be '/'");
  }

  return normalized;
}

/**
 * Zod schema for `AdminPluginConfig`. Used by `createAdminPlugin` to validate
 * raw config at startup.
 *
 * @remarks
 * **Validation behavior:** Each provider field uses `z.object({...}).passthrough()`
 * which validates the value is a proper object whose required methods exist at
 * schema-parse time. This provides stronger validation than `z.custom<T>()`
 * (which only checked for a non-null object). Method signature details are
 * checked separately via `validateAdapterShape()`, which throws with a
 * descriptive message if a required method is missing.
 *
 * Validate your config object against this schema early (e.g. at module load
 * time) to surface misconfiguration before any HTTP traffic arrives. If you
 * are composing config dynamically (e.g. from environment variables), prefer
 * `safeParse()` over `parse()` so you can handle errors without an uncaught
 * exception.
 *
 * **Optional fields:** `mailRenderer` and `auditLog` may be omitted. When
 * `mailRenderer` is absent, admin email endpoints return `501 Not Implemented`.
 * When `auditLog` is absent, admin actions are not recorded.
 *
 * @example
 * ```ts
 * import { adminPluginConfigSchema } from '@lastshotlabs/slingshot-admin';
 *
 * const result = adminPluginConfigSchema.safeParse(rawConfig);
 * if (!result.success) throw new Error(result.error.toString());
 * const config = result.data; // typed as AdminPluginConfig
 * ```
 */
export const adminPluginConfigSchema = z.object({
  /** Mount path for admin routes. Default: '/admin' */
  mountPath: z
    .string()
    .transform(value => normalizeMountPath(value))
    .optional()
    .describe(
      "URL path prefix for admin routes. Must start with '/'. Trailing slashes are trimmed. Omit to use '/admin'.",
    ),
  /** Provider for admin access verification */
  accessProvider: AdminAccessProviderSchema.describe(
    'Admin access verification provider. In manifest mode, accepts "slingshot-auth" which is ' +
      'resolved to an AdminAccessProvider before the plugin factory.',
  ),
  /** Provider for managed user operations */
  managedUserProvider: ManagedUserProviderSchema.describe(
    'Managed user provider. In manifest mode, accepts "slingshot-auth" which is resolved ' +
      'to a ManagedUserProvider before the plugin factory.',
  ),
  /** Mail template renderer for admin emails */
  mailRenderer: MailRendererSchema.optional().describe(
    'Mail template renderer used by admin email endpoints. Omit to disable admin email sending.',
  ),
  /** Audit log provider for tracking admin actions */
  auditLog: AuditLogProviderSchema.optional().describe(
    'Audit-log provider. In manifest mode, accepts "memory" which is resolved to an ' +
      'in-memory AuditLogProvider before the plugin factory. Omit to skip audit logging.',
  ),
  /**
   * Optional pluggable store backing the destructive-mutation rate limiter.
   *
   * Defaults to an in-process `Map`-backed implementation, which is fine for
   * single-instance deploys and tests. Production deploys with multiple
   * replicas should inject a Redis-backed store via `createRedisRateLimitStore`
   * so the counter is shared across instances.
   */
  rateLimitStore: AdminRateLimitStoreSchema.optional().describe(
    'Pluggable rate-limit store. Omit to use an in-process default (single-instance only).',
  ),
  /** Required permissions system */
  permissions: z
    .object({
      evaluator: PermissionEvaluatorSchema.describe(
        'Permission evaluator used to authorize admin actions.',
      ),
      registry: PermissionRegistrySchema.describe(
        'Permission registry that stores role and permission definitions.',
      ),
      adapter: PermissionsAdapterSchema.describe(
        'Permissions adapter used to assign and revoke subject grants.',
      ),
    })
    .describe(
      'Permissions services. In manifest mode, accepts "slingshot-permissions" which is resolved ' +
        'to evaluator/registry/adapter from the permissions plugin state before the plugin factory.',
    ),
});
