import { z } from 'zod';
import type { EntityRouteDataScopeSource } from './entityRouteConfig';

const FORBIDDEN_EVENT_PREFIXES = ['security.', 'auth:', 'community:delivery.', 'push:', 'app:'];

function isForbiddenEventKey(key: string): boolean {
  return FORBIDDEN_EVENT_PREFIXES.some(p => key.startsWith(p));
}

const routeAuthSchema = z.enum(['userAuth', 'bearer', 'none']);

const policyApplyToSchema = z
  .string()
  .regex(
    /^(create|list|get|update|delete|operation:[a-zA-Z_][a-zA-Z0-9_]*)$/,
    "policy.applyTo entries must be 'create' | 'list' | 'get' | 'update' | 'delete' or 'operation:<opName>'",
  );

const entityRoutePolicyConfigSchema = z.object({
  resolver: z.string().min(1),
  applyTo: z.array(policyApplyToSchema).min(1).optional(),
  leakSafe: z.boolean().optional(),
});

const routePermissionSchema = z.object({
  requires: z.string().min(1),
  ownerField: z.string().optional(),
  or: z.string().optional(),
  scope: z.record(z.string(), z.string()).optional(),
  parentAuth: z
    .object({
      idParam: z.string().min(1),
      tenantField: z.string().min(1),
    })
    .optional(),
  policy: entityRoutePolicyConfigSchema.optional(),
});

const routeRateLimitSchema = z.object({
  windowMs: z.number().int().positive(),
  max: z.number().int().positive(),
});

const eventKeySchema = z
  .string()
  .min(1)
  .refine(key => !isForbiddenEventKey(key), {
    message:
      'Event key uses a forbidden namespace (security., auth:, community:delivery., push:, app:)',
  });

const routeEventSchema = z.union([
  eventKeySchema,
  z.object({
    key: eventKeySchema,
    payload: z.array(z.string()).optional(),
    include: z.array(z.enum(['tenantId', 'actorId', 'requestId', 'ip'])).optional(),
  }),
]);

const routeOperationConfigSchema = z.object({
  auth: routeAuthSchema.optional(),
  permission: routePermissionSchema.optional(),
  rateLimit: routeRateLimitSchema.optional(),
  event: routeEventSchema.optional(),
  middleware: z.array(z.string()).optional(),
});

const namedOpHttpMethodSchema = z.enum(['get', 'post', 'put', 'patch', 'delete']);

const routeNamedOperationConfigSchema = routeOperationConfigSchema.extend({
  method: namedOpHttpMethodSchema.optional(),
  path: z.string().min(1).optional(),
});

const webhookConfigSchema = z.object({
  payload: z.array(z.string()).optional(),
});

const retentionConfigSchema = z.object({
  hardDelete: z
    .object({
      after: z
        .string()
        .regex(
          /^[1-9]\d*[smhdwy]$/,
          'Duration must be a positive number followed by s/m/h/d/w/y (e.g. "90d", "1y")',
        ),
      when: z.record(z.string(), z.unknown()),
    })
    .optional(),
});

const entityPermissionConfigSchema = z.object({
  resourceType: z.string().min(1),
  scopeField: z.string().optional(),
  actions: z.array(z.string().min(1)).min(1),
  roles: z.record(z.string(), z.array(z.string())).optional(),
});

const cascadeConfigSchema = z.object({
  event: z.string().min(1),
  batch: z.object({
    action: z.enum(['update', 'delete']),
    filter: z.record(z.string(), z.unknown()),
    set: z.record(z.string(), z.unknown()).optional(),
  }),
});

const dataScopedCrudOpSchema = z.enum(['list', 'get', 'create', 'update', 'delete']);

const dataScopeSourceSchema = z.custom<EntityRouteDataScopeSource>(
  value => {
    if (typeof value !== 'string') return false;
    return /^(ctx|param):[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);
  },
  {
    message:
      "dataScope.from must start with 'ctx:' or 'param:' followed by an identifier (e.g. 'ctx:authUserId')",
  },
);

const entityRouteDataScopeConfigSchema = z.object({
  field: z.string().min(1),
  from: dataScopeSourceSchema,
  applyTo: z.array(dataScopedCrudOpSchema).min(1).optional(),
});

/**
 * Zod schema for validating an {@link EntityRouteConfig} input at runtime.
 *
 * Used by plugin bootstrap and the {@link validateEntityRouteConfig} helper to catch
 * misconfigured entity route declarations early, before server startup. Pass any raw
 * config object (from JSON, YAML, or untyped module exports) to get structured Zod errors
 * rather than opaque runtime failures.
 *
 * @remarks
 * Forbidden event key namespaces (`security.`, `auth:`, `community:delivery.`, `push:`,
 * `app:`) are enforced by the inline `eventKeySchema` applied to every event key field
 * across `create`, `get`, `list`, `update`, `delete`, and `operations` entries. Any event
 * key using a forbidden prefix causes validation to fail with a descriptive Zod issue.
 * Rate limit fields (`windowMs`, `max`) must be positive integers — zero and negative
 * values are rejected. The `retention.hardDelete.after` duration string must match
 * `{positive integer}{s|m|h|d|w|y}` (e.g. `'90d'`, `'1y'`).
 *
 * @example
 * ```ts
 * import { entityRouteConfigSchema } from '@lastshotlabs/slingshot-core';
 *
 * // Parse and throw on invalid input:
 * const config = entityRouteConfigSchema.parse(rawConfig);
 *
 * // Or validate without throwing — see validateEntityRouteConfig for the safe variant.
 * const result = entityRouteConfigSchema.safeParse(rawConfig);
 * ```
 */
export const entityRouteConfigSchema = z
  .object({
    create: routeOperationConfigSchema.optional(),
    get: routeOperationConfigSchema.optional(),
    list: routeOperationConfigSchema.optional(),
    update: routeOperationConfigSchema.optional(),
    delete: routeOperationConfigSchema.optional(),
    operations: z.record(z.string(), routeNamedOperationConfigSchema).optional(),
    defaults: routeOperationConfigSchema.optional(),
    dataScope: z
      .union([entityRouteDataScopeConfigSchema, z.array(entityRouteDataScopeConfigSchema).min(1)])
      .optional(),
    disable: z.array(z.string()).optional(),
    clientSafeEvents: z.array(z.string()).optional(),
    webhooks: z.record(z.string(), webhookConfigSchema).optional(),
    retention: retentionConfigSchema.optional(),
    permissions: entityPermissionConfigSchema.optional(),
    middleware: z.record(z.string(), z.literal(true)).optional(),
    cascades: z.array(cascadeConfigSchema).optional(),
  })
  .superRefine((cfg, ctx) => {
    const isAuthEnabled = (auth: string | undefined): boolean =>
      auth === 'userAuth' || auth === 'bearer';

    const crudAuthEnabled =
      isAuthEnabled(cfg.defaults?.auth) ||
      isAuthEnabled(cfg.create?.auth) ||
      isAuthEnabled(cfg.get?.auth) ||
      isAuthEnabled(cfg.list?.auth) ||
      isAuthEnabled(cfg.update?.auth) ||
      isAuthEnabled(cfg.delete?.auth);
    const namedAuthEnabled = Object.values(cfg.operations ?? {}).some(op => isAuthEnabled(op.auth));

    if (cfg.dataScope && !crudAuthEnabled && !namedAuthEnabled) {
      ctx.addIssue({
        code: 'custom',
        path: ['dataScope'],
        message:
          "routes.dataScope requires auth - set defaults.auth or an operation.auth to 'userAuth' or 'bearer'. A public route with dataScope cannot resolve its context value and would return 401 on every request.",
      });
    }

    // Policy requires auth — the resolver needs a userId.
    const declaresPolicy =
      cfg.create?.permission?.policy ||
      cfg.get?.permission?.policy ||
      cfg.list?.permission?.policy ||
      cfg.update?.permission?.policy ||
      cfg.delete?.permission?.policy ||
      cfg.defaults?.permission?.policy ||
      Object.values(cfg.operations ?? {}).some(op => op.permission?.policy);

    if (declaresPolicy && !crudAuthEnabled && !namedAuthEnabled) {
      ctx.addIssue({
        code: 'custom',
        path: ['permission', 'policy'],
        message:
          "permission.policy requires auth — set defaults.auth or an operation.auth to 'userAuth' or 'bearer'. A public route cannot provide a userId to the resolver.",
      });
    }
  });

/**
 * The input type accepted by `entityRouteConfigSchema`.
 *
 * Equivalent to {@link EntityRouteConfig} from `entityRouteConfig.ts` but reflects
 * Zod's input-side coercions (i.e., what you pass *in* before parsing). Use this type
 * when working with raw or partially-typed config objects that will be validated before
 * use — for example, configs read from JSON files or constructed dynamically.
 *
 * @remarks
 * In practice `EntityRouteConfigInput` and `EntityRouteConfig` are structurally
 * identical because the schema contains no transformations. Prefer importing
 * `EntityRouteConfig` directly when your config object is already validated.
 */
export type EntityRouteConfigInput = z.input<typeof entityRouteConfigSchema>;

/**
 * Validate an entity route config object against {@link entityRouteConfigSchema}.
 *
 * Returns `{ success: true }` on valid input, or `{ success: false, errors }` with
 * structured Zod validation errors on failure. Never throws — all error information is
 * returned in the result object so callers can surface messages without try/catch.
 *
 * Call this during plugin bootstrap or server startup to catch misconfigured entity route
 * declarations (invalid auth strategies, forbidden event namespaces, malformed duration
 * strings, etc.) before any routes are registered.
 *
 * @param config - The raw config object to validate. Typed as `unknown` so it is safe
 *   to pass configs read from JSON, user input, or untyped module exports.
 * @returns An object with `success: true` when validation passes, or
 *   `{ success: false, errors: ZodError }` on failure. Access `errors.format()` for
 *   a nested error map or `errors.issues` for the flat issue list.
 *
 * @remarks
 * This function does not throw. If you need the validated, typed value rather than a
 * boolean result, use `entityRouteConfigSchema.parse(config)` directly (which does throw).
 *
 * @example
 * ```ts
 * import { validateEntityRouteConfig } from '@lastshotlabs/slingshot-core';
 *
 * const result = validateEntityRouteConfig(rawConfig);
 * if (!result.success) {
 *   console.error('Invalid entity route config:', result.errors?.format());
 *   process.exit(1);
 * }
 * // rawConfig is safe to use as EntityRouteConfig from here.
 * ```
 */
export function validateEntityRouteConfig(config: unknown): {
  success: boolean;
  errors?: z.ZodError;
} {
  const result = entityRouteConfigSchema.safeParse(config);
  return result.success ? { success: true } : { success: false, errors: result.error };
}
