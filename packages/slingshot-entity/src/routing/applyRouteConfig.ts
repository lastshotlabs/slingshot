/**
 * applyRouteConfig — wires auth, permissions, rate limits, events, and custom
 * middleware onto a Hono router by reading an EntityRouteConfig object.
 *
 * Pure runtime function. No codegen. No side effects outside the router.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type {
  AppEnv,
  EntityRouteConfig,
  EntityRoutePolicyConfig,
  PermissionEvaluator,
  PermissionRegistry,
  PolicyResolver,
  ResolvedEntityConfig,
  RouteOperationConfig,
  SlingshotEventBus,
} from '@lastshotlabs/slingshot-core';
import { getSlingshotCtx, resolveOpConfig } from '@lastshotlabs/slingshot-core';
import { entityToPath } from '../generators/routeHelpers';
import { buildPolicyAction, policyAppliesToOp, resolvePolicy } from '../policy/resolvePolicy';
import { safeReadJsonBody } from '../policy/safeReadJsonBody';
import { evaluateRouteAuth } from './evaluateRouteAuth';

/**
 * Operations where the pre-handler policy pass must be skipped.
 *
 * - `get`, `update`, `delete` — have a post-fetch policy pass in
 *   `buildBareEntityRoutes` that runs with the actual record. Running the
 *   pre-handler pass for these ops would force dispatch-based resolvers to
 *   handle null record + null input, which they cannot do (the discriminator
 *   lives on the record, not the request body).
 * - `list` — no request body to dispatch on and no post-fetch pass.
 *   List operations rely on permission checks; per-record policy cannot
 *   apply pre-fetch.
 */
const SKIP_PRE_HANDLER_POLICY_OPS = new Set(['get', 'update', 'delete', 'list']);

// ---------------------------------------------------------------------------
// Method-aware middleware
// ---------------------------------------------------------------------------

/**
 * Map an operation name to the HTTP methods it serves.
 *
 * Without this mapping, `router.use(path, handler)` registers middleware for
 * every method at that path — meaning a `permission` check declared on
 * `create` (POST /containers) would also block `list` (GET /containers).
 */
function opMethods(opName: string): Set<string> {
  switch (opName) {
    case 'create':
      return new Set(['POST']);
    case 'list':
      return new Set(['GET']);
    case 'get':
      return new Set(['GET']);
    case 'update':
      // buildBareEntityRoutes registers PATCH only — keep in sync.
      return new Set(['PATCH']);
    case 'delete':
      return new Set(['DELETE']);
    default:
      // Named operations are registered as POST by buildBareEntityRoutes.
      return new Set(['POST']);
  }
}

/**
 * Wrap a middleware handler so it only executes for the given HTTP methods.
 * Other methods pass straight through to the next handler.
 */
function methodGuard(methods: Set<string>, handler: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    if (!methods.has(c.req.method)) {
      await next();
      return;
    }
    return handler(c, next);
  };
}

/**
 * Runtime dependencies for `applyRouteConfig()`.
 *
 * All fields are optional — only supply what the entity route config actually
 * uses (e.g. omit `rateLimitFactory` when no route declares `rateLimit`).
 *
 * @example
 * ```ts
 * import { applyRouteConfig } from '@lastshotlabs/slingshot-entity/routing';
 * import type { RouteConfigDeps } from '@lastshotlabs/slingshot-entity/routing';
 * import { OpenAPIHono } from '@hono/zod-openapi';
 *
 * const deps: RouteConfigDeps = {
 *   bus,
 *   permissionEvaluator,
 *   rateLimitFactory: (opts) => rateLimitMiddleware(opts),
 *   middleware: { requireAdmin: adminMiddleware },
 *   adapter: messageAdapter,
 * };
 *
 * const router = new OpenAPIHono();
 * applyRouteConfig(router, Message, Message.routes!, deps);
 * ```
 */
export interface RouteConfigDeps {
  /** Event bus for emitting operation events and registering client-safe events. */
  bus?: SlingshotEventBus;
  /** Permission evaluator used when any operation declares a `permission` check. */
  permissionEvaluator?: PermissionEvaluator;
  /** Permission registry used to register the entity's resource type. */
  permissionRegistry?: PermissionRegistry;
  /**
   * Factory that produces a rate-limit middleware from options.
   * Required when any operation declares a `rateLimit` config.
   */
  rateLimitFactory?: (opts: { windowMs: number; max: number }) => MiddlewareHandler;
  /**
   * Named middleware handlers referenced by operation `middleware` arrays.
   * Keys must match the names used in the entity's `routes.middleware` config.
   */
  middleware?: Record<string, MiddlewareHandler>;
  /**
   * Mutable array that receives collected webhook event keys.
   * Used by the framework to build the webhook filter list.
   */
  webhookEventKeys?: string[];
  /**
   * Adapter with a `getById` method for ownership-based permission checks.
   * Required when any operation declares `permission.ownerField`.
   */
  adapter?: { getById(id: string): Promise<unknown> };
  /**
   * Optional URL path segment override. When set, replaces
   * `entityToPath(entityConfig.name)` for all route and middleware registrations.
   * Must match the segment used by `buildBareEntityRoutes` to ensure middleware
   * fires on the correct paths.
   */
  routePath?: string;

  /**
   * Parent path prefix for nested resource routes (e.g. `'/documents/:id'`).
   * When set, all middleware paths are prefixed with this value:
   * `parentPath/entitySegment`, `parentPath/entitySegment/:id`, etc.
   * Must match the prefix used by `buildBareEntityRoutes`.
   */
  parentPath?: string;

  /**
   * Adapter for the parent entity, used by `permission.parentAuth` checks.
   * Required when any operation declares `permission.parentAuth`.
   */
  parentAdapter?: { getById(id: string): Promise<unknown> };

  /**
   * Resolved policy resolvers, keyed by resolver name. Populated at
   * `setupRoutes` time from the policy registry. Used by the pre-handler
   * policy pass.
   */
  policyResolvers?: ReadonlyMap<string, PolicyResolver>;
}

/**
 * Apply declarative route configuration to a Hono router.
 *
 * Registers Hono middleware on the provided router for each configured
 * operation (CRUD + named operations), enforcing:
 * - **Auth** — `userAuth` or `bearer` middleware via the framework auth layer.
 * - **Rate limiting** — using the injected `rateLimitFactory`.
 * - **Custom middleware** — named handlers from `deps.middleware`.
 * - **Permissions** — subject/scope-aware checks via `permissionEvaluator`.
 * - **Event emission** — after-response middleware that emits declared events
 *   on successful responses.
 *
 * Middleware is registered **method-aware** — a permission check declared on
 * `create` (POST) does not run for `list` (GET) on the same path.
 *
 * @param router - The Hono-compatible router to register middleware on.
 *   Route handlers must be registered on the same router (before or after
 *   this call, since event middleware uses `router.use('*')`).
 * @param entityConfig - Resolved entity config (used for path derivation and
 *   ownership checks).
 * @param routeConfig - Declarative route config from `EntityConfig.routes`.
 * @param deps - Runtime dependencies (bus, evaluator, rate limiter, middleware).
 *
 * @remarks
 * In `createEntityPlugin()`, this function is called **before**
 * `buildBareEntityRoutes()` so that auth/rate-limit middleware is registered
 * before the route handlers that actually process requests.
 *
 * @example
 * ```ts
 * import { applyRouteConfig, buildBareEntityRoutes } from '@lastshotlabs/slingshot-entity/routing';
 * import { OpenAPIHono } from '@hono/zod-openapi';
 *
 * const router = new OpenAPIHono();
 * applyRouteConfig(router, Message, Message.routes!, { bus, permissionEvaluator });
 * buildBareEntityRoutes(Message, MessageOps.operations, adapter, router);
 * app.route('/api', router);
 * ```
 */
type RouteMiddlewareRegistrar = {
  use(path: string, ...handlers: MiddlewareHandler<AppEnv>[]): unknown;
};

export function applyRouteConfig(
  router: RouteMiddlewareRegistrar,
  entityConfig: ResolvedEntityConfig,
  routeConfig: EntityRouteConfig,
  deps: RouteConfigDeps,
): void {
  const { bus, permissionEvaluator, permissionRegistry, rateLimitFactory, middleware: mw } = deps;
  const entitySegment = deps.routePath ?? entityToPath(entityConfig.name);
  const path = deps.parentPath
    ? `${deps.parentPath.replace(/^\//, '')}/${entitySegment}`
    : entitySegment;

  // 1. Client-safe events
  if (routeConfig.clientSafeEvents?.length && bus) {
    bus.registerClientSafeEvents(routeConfig.clientSafeEvents);
  }

  // 2. Permission resource registration
  if (routeConfig.permissions && permissionRegistry) {
    try {
      permissionRegistry.register({
        resourceType: routeConfig.permissions.resourceType,
        actions: routeConfig.permissions.actions,
        roles: routeConfig.permissions.roles ?? {},
      });
    } catch {
      // already registered — safe to ignore
    }
  }

  // 3. Webhook event key collection
  if (routeConfig.webhooks && deps.webhookEventKeys) {
    for (const eventKey of Object.keys(routeConfig.webhooks)) {
      deps.webhookEventKeys.push(eventKey);
    }
  }

  // 4. Per-operation wiring
  const allOpNames = [
    'create',
    'list',
    'get',
    'update',
    'delete',
    ...Object.keys(routeConfig.operations ?? {}),
  ];
  const disabledOps = new Set(routeConfig.disable ?? []);
  const eventMap = new Map<string, { key: string; payload?: string[] }>();

  for (const opName of allOpNames) {
    if (disabledOps.has(opName)) continue;

    const opConfig = resolveOpConfig(routeConfig, opName);
    if (!opConfig) continue;

    // For named (non-CRUD) ops, allow HTTP method and path overrides from route config.
    const namedOpMethod = ['create', 'list', 'get', 'update', 'delete'].includes(opName)
      ? undefined
      : routeConfig.operations?.[opName]?.method;
    const namedOpPath = ['create', 'list', 'get', 'update', 'delete'].includes(opName)
      ? undefined
      : routeConfig.operations?.[opName]?.path;
    const paths = getOpPaths(path, opName, namedOpPath);
    const methods = namedOpMethod ? new Set([namedOpMethod.toUpperCase()]) : opMethods(opName);

    for (const opPath of paths) {
      // Rate limit middleware
      if (opConfig.rateLimit && rateLimitFactory) {
        router.use(opPath, methodGuard(methods, rateLimitFactory(opConfig.rateLimit)));
      }

      // Custom middleware
      if (opConfig.middleware && mw) {
        for (const name of opConfig.middleware) {
          const handler = (mw as Record<string, MiddlewareHandler | undefined>)[name];
          if (handler) router.use(opPath, methodGuard(methods, handler));
        }
      }

      if (opConfig.auth || opConfig.permission) {
        router.use(
          opPath,
          methodGuard(methods, async (c, next) => {
            const slingshotCtx = getSlingshotCtx(
              c as unknown as Parameters<typeof getSlingshotCtx>[0],
            );
            const authResult = await evaluateRouteAuth(c as Context<AppEnv, string>, opConfig, {
              routeAuth: slingshotCtx.routeAuth,
              permissionEvaluator,
              adapter: deps.adapter,
              parentAdapter: deps.parentAdapter,
            });
            if (!authResult.authorized) {
              return authResult.response ?? c.json({ error: 'Forbidden' }, 403);
            }

            // Policy pre-handler pass — runs with record: null (no adapter
            // call yet). Only fires for create, list, and named ops where
            // there is no post-fetch pass. get/update/delete have a post-fetch
            // policy pass in buildBareEntityRoutes that runs with the actual
            // record — running the pre-handler pass for those ops would force
            // dispatch-based resolvers to handle null record + null input,
            // which they cannot do (the discriminator lives on the record).
            const hasPostFetchPolicyPass = SKIP_PRE_HANDLER_POLICY_OPS.has(opName);
            if (!hasPostFetchPolicyPass) {
              const policyConfig = resolvePolicyConfig(opConfig, routeConfig);
              if (policyConfig && deps.policyResolvers && policyAppliesToOp(policyConfig, opName)) {
                const policyResolver = deps.policyResolvers.get(policyConfig.resolver);
                if (policyResolver) {
                  const input = await safeReadJsonBody(c);
                  await resolvePolicy({
                    c,
                    config: policyConfig,
                    resolver: policyResolver,
                    action: buildPolicyAction(opName),
                    record: null,
                    input,
                    bus,
                  });
                }
              }
            }

            await next();
          }),
        );
      }

      // Collect events for after-response middleware
      collectOpEvent(opConfig, opName, eventMap);
    }
  }

  // 5. Event emission — after-response middleware
  if (eventMap.size > 0 && bus) {
    const capturedBus = bus;
    router.use('*', async (c, next) => {
      await next();
      if (c.res.status < 200 || c.res.status >= 300) return;

      const opName = c.get('__opName' as never) as string | undefined;
      const result = c.get('__opResult' as never) as Record<string, unknown> | undefined;
      if (!opName || !result) return;

      const evt = eventMap.get(opName);
      if (!evt) return;

      const payload: Record<string, unknown> = {
        tenantId: c.get('tenantId' as never),
        actorId: c.get('authUserId' as never),
      };
      if (evt.payload && evt.payload.length > 0) {
        for (const f of evt.payload) payload[f] = result[f];
      } else {
        Object.assign(payload, { entity: result });
      }
      // bus.emit() is typed against SlingshotEventMap which uses static keys.
      // Config-driven event keys are dynamic strings not in the static map.
      // The cast is safe: at runtime any string key is valid, type safety
      // comes from the generated events.ts module augmentation.
      (capturedBus as unknown as { emit(key: string, payload: unknown): void }).emit(
        evt.key,
        payload,
      );
    });
  }
}

/**
 * Register an operation's event declaration in the shared `eventMap`.
 *
 * Both shorthand string form (`event: 'my.event'`) and object form
 * (`event: { key: 'my.event', payload: ['id'] }`) are normalised to
 * `{ key, payload }` before insertion.
 *
 * @param opConfig - The route operation config to inspect.
 * @param opName - The operation name used as the map key (e.g. `'create'`,
 *   `'publish'`).
 * @param eventMap - The accumulator map that the event emission middleware
 *   reads from after the route handler runs.
 */
/**
 * Resolve the effective policy config for an operation.
 *
 * Operation-level `permission.policy` overrides `defaults.permission.policy`.
 * Returns `undefined` if no policy is configured.
 */
function resolvePolicyConfig(
  opConfig: RouteOperationConfig,
  routeConfig: EntityRouteConfig,
): EntityRoutePolicyConfig | undefined {
  return opConfig.permission?.policy ?? routeConfig.defaults?.permission?.policy;
}

function collectOpEvent(
  opConfig: RouteOperationConfig,
  opName: string,
  eventMap: Map<string, { key: string; payload?: string[] }>,
): void {
  if (!opConfig.event) return;
  const evt = typeof opConfig.event === 'string' ? { key: opConfig.event } : opConfig.event;
  eventMap.set(opName, { key: evt.key, payload: 'payload' in evt ? evt.payload : undefined });
}

/**
 * Return the Hono route path(s) for a given operation on an entity path segment.
 *
 * Follows the same URL conventions as `entityToPath()` in `routeHelpers.ts`.
 *
 * @param segment - The entity URL segment (e.g. `'messages'`, `'user-profiles'`).
 * @param opName - The operation name (a CRUD name or a named operation).
 * @returns An array of Hono path strings for the operation:
 *   - `create` → `['/{segment}']`
 *   - `list`   → `['/{segment}']`
 *   - `get`    → `['/{segment}/:id']`
 *   - `update` → `['/{segment}/:id']`
 *   - `delete` → `['/{segment}/:id']`
 *   - named    → `['/{segment}/{kebab-opName}']`
 *
 * Named operations use only the kebab-case path. An earlier design also
 * registered `/{segment}/:opName` as a camelCase fallback, but that path
 * acts as a wildcard matching *any* sibling route under the same segment,
 * causing cross-contamination when multiple named ops exist (e.g.
 * listBySource middleware firing on closePoll requests).
 */
function getOpPaths(segment: string, opName: string, pathOverride?: string): string[] {
  switch (opName) {
    case 'create':
      return [`/${segment}`];
    case 'list':
      return [`/${segment}`];
    case 'get':
      return [`/${segment}/:id`];
    case 'update':
      return [`/${segment}/:id`];
    case 'delete':
      return [`/${segment}/:id`];
    default: {
      // Use explicit path override (must match op.custom http.path) or fall back to
      // camelCase → kebab-case conversion, same as buildBareEntityRoutes.
      const segment2 = pathOverride ?? opName.replace(/([A-Z])/g, '-$1').toLowerCase();
      return [`/${segment}/${segment2}`];
    }
  }
}
