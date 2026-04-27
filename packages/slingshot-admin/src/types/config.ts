import { z } from 'zod';

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

import type {
  AuditLogProvider,
  MailRenderer,
  PermissionEvaluator,
  PermissionRegistry,
  PermissionsAdapter,
} from '@lastshotlabs/slingshot-core';
import type { AdminAccessProvider, ManagedUserProvider } from '@lastshotlabs/slingshot-core';

/**
 * Zod schema for `AdminPluginConfig`. Used by `createAdminPlugin` to validate
 * raw config at startup. All provider fields are validated as non-null objects;
 * required methods are checked separately via `validateAdapterShape`.
 *
 * @remarks
 * **Validation behavior:** Each provider field uses `z.custom<T>()` which only
 * checks that the value is a non-null object — it does **not** verify that
 * required methods exist at schema-validation time. Method presence is checked
 * separately in `createAdminPlugin` via `validateAdapterShape()`, which throws
 * with a descriptive message if a required method is missing.
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
  accessProvider: z
    .custom<AdminAccessProvider>(v => v != null && typeof v === 'object', {
      message: 'Expected an AdminAccessProvider instance',
    })
    .describe(
      'Admin access verification provider. In manifest mode, accepts "slingshot-auth" which is ' +
        'resolved to an AdminAccessProvider before the plugin factory.',
    ),
  /** Provider for managed user operations */
  managedUserProvider: z
    .custom<ManagedUserProvider>(v => v != null && typeof v === 'object', {
      message: 'Expected a ManagedUserProvider instance',
    })
    .describe(
      'Managed user provider. In manifest mode, accepts "slingshot-auth" which is resolved ' +
        'to a ManagedUserProvider before the plugin factory.',
    ),
  /** Mail template renderer for admin emails */
  mailRenderer: z
    .custom<MailRenderer>(v => v != null && typeof v === 'object', {
      message: 'Expected a MailRenderer instance',
    })
    .optional()
    .describe(
      'Mail template renderer used by admin email endpoints. Omit to disable admin email sending.',
    ),
  /** Audit log provider for tracking admin actions */
  auditLog: z
    .custom<AuditLogProvider>(v => v != null && typeof v === 'object', {
      message: 'Expected an AuditLogProvider instance',
    })
    .optional()
    .describe(
      'Audit-log provider. In manifest mode, accepts "memory" which is resolved to an ' +
        'in-memory AuditLogProvider before the plugin factory. Omit to skip audit logging.',
    ),
  /** Required permissions system */
  permissions: z
    .object({
      evaluator: z
        .custom<PermissionEvaluator>(v => v != null && typeof v === 'object', {
          message: 'Expected a PermissionEvaluator instance',
        })
        .describe('Permission evaluator used to authorize admin actions.'),
      registry: z
        .custom<PermissionRegistry>(v => v != null && typeof v === 'object', {
          message: 'Expected a PermissionRegistry instance',
        })
        .describe('Permission registry that stores role and permission definitions.'),
      adapter: z
        .custom<PermissionsAdapter>(v => v != null && typeof v === 'object', {
          message: 'Expected a PermissionsAdapter instance',
        })
        .describe('Permissions adapter used to assign and revoke subject grants.'),
    })
    .describe(
      'Permissions services. In manifest mode, accepts "slingshot-permissions" which is resolved ' +
        'to evaluator/registry/adapter from the permissions plugin state before the plugin factory.',
    ),
});

/**
 * Configuration object for the Slingshot admin plugin.
 *
 * @remarks
 * Inferred from `adminPluginConfigSchema` via `z.infer<>`. All fields map
 * directly to injectable provider interfaces — the plugin itself has no
 * persistence of its own. This keeps `createAdminPlugin` fully decoupled from
 * any specific auth backend, user store, or audit log implementation.
 *
 * **Provider field summary:**
 * - `mountPath` — Route prefix for all admin endpoints. Default: `'/admin'`.
 * - `accessProvider` — Verifies incoming JWTs / sessions and returns an
 *   `AdminPrincipal`. Use `createAuth0AccessProvider()` for Auth0 or
 *   `createMemoryAccessProvider()` for testing.
 * - `managedUserProvider` — Reads and mutates user records (list, get, update,
 *   suspend, delete). Implementation is application-specific.
 * - `mailRenderer` — Optional. Renders admin email templates (e.g. password
 *   reset). When absent, email endpoints return `501`.
 * - `auditLog` — Optional. Records admin actions for compliance. When absent,
 *   actions are not logged.
 * - `permissions.evaluator` — Checks whether a principal can perform an action
 *   on a resource.
 * - `permissions.registry` — Stores and retrieves role/permission definitions.
 * - `permissions.adapter` — Assigns and revokes roles for subjects.
 */
export type AdminPluginConfig = z.infer<typeof adminPluginConfigSchema>;
