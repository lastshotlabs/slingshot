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
  OperationConfig,
  PermissionEvaluator,
  PermissionRegistry,
  PolicyResolver,
  ResolvedEntityConfig,
  RouteEventConfig,
  RouteIdempotencyConfig,
  RouteOperationConfig,
  SlingshotEventBus,
  SlingshotEventMap,
  SlingshotEvents,
} from '@lastshotlabs/slingshot-core';
import {
  HEADER_IDEMPOTENCY_KEY,
  getActor,
  getPolicyResolverKey,
  getRequestTenantId,
  getSlingshotCtx,
  hmacSign,
  resolveOpConfig,
  sha256,
} from '@lastshotlabs/slingshot-core';
import { entityToPath } from '../generators/routeHelpers';
import { buildPolicyAction, policyAppliesToOp, resolvePolicy } from '../policy/resolvePolicy';
import { safeReadJsonBody } from '../policy/safeReadJsonBody';
import type { PlannedEntityRoute } from './entityRoutePlanning';
import { evaluateRouteAuth } from './evaluateRouteAuth';
import { resolveNamedOperationRoute } from './namedOperationRouting';

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

function normalizeIdempotencyConfig(
  config: RouteOperationConfig['idempotency'],
): Required<RouteIdempotencyConfig> | null {
  if (!config) return null;
  if (config === true) {
    return { ttl: 86400, scope: 'user' };
  }
  return {
    ttl: config.ttl ?? 86400,
    scope: config.scope ?? 'user',
  };
}

async function buildRequestFingerprint(c: Context<AppEnv, string>): Promise<string> {
  const url = new URL(c.req.url);
  const contentType = c.req.header('content-type') ?? '';
  const body = await c.req.raw
    .clone()
    .text()
    .catch(() => '');
  return sha256(`${c.req.method}\n${url.pathname}\n${url.search}\n${contentType}\n${body}`);
}

function buildScopedIdempotencyKey(
  rawKey: string,
  entityName: string,
  opName: string,
  c: Context<AppEnv, string>,
  config: Required<RouteIdempotencyConfig>,
): string {
  const slingshotCtx = getSlingshotCtx(c as unknown as Parameters<typeof getSlingshotCtx>[0]);
  const signingConfig = slingshotCtx.signing;
  const signingSecret = signingConfig?.secret ?? null;
  const keyToken =
    signingConfig?.idempotencyKeys && signingSecret ? hmacSign(rawKey, signingSecret) : rawKey;
  const actor = getActor(c);

  const requestTenantId = getRequestTenantId(c);
  const parts = ['entity-idempotency', entityName, opName];
  switch (config.scope) {
    case 'global':
      parts.push('global');
      break;
    case 'tenant':
      parts.push(`tenant:${requestTenantId ?? 'none'}`);
      break;
    case 'user':
      if (!actor.id) {
        throw new Error(
          `Entity route idempotency for ${entityName}.${opName} requires actor.id when scope is 'user'`,
        );
      }
      parts.push(`tenant:${requestTenantId ?? 'none'}`);
      parts.push(`user:${actor.id}`);
      break;
  }
  parts.push(keyToken);
  return parts.join(':');
}

function idempotencyConflictResponse(c: Context<AppEnv, string>): Response {
  return c.json(
    {
      error: 'Idempotency-Key reuse with different request',
      code: 'idempotency_key_conflict',
    },
    409,
  );
}

async function captureResponsePayload(
  response: Response,
): Promise<{ body: string; encoding: 'base64' | 'utf8' } | null> {
  try {
    const buffer = Buffer.from(await response.clone().arrayBuffer());
    return {
      body: buffer.toString('base64'),
      encoding: 'base64',
    };
  } catch {
    // Response body may be unreadable (e.g. stream already consumed) — skip capture
    return null;
  }
}

function replayStoredResponse(record: {
  response: string;
  status: number;
  responseHeaders?: Record<string, string> | null;
  responseEncoding?: 'base64' | 'utf8' | null;
}): Response {
  const body =
    record.responseEncoding === 'base64' ? Buffer.from(record.response, 'base64') : record.response;
  return new Response(body, {
    status: record.status,
    headers: record.responseHeaders ?? undefined,
  });
}

function captureResponseHeaders(response: Response): Record<string, string> | null {
  const headers = Object.fromEntries(response.headers.entries());
  return Object.keys(headers).length > 0 ? headers : null;
}

function createEntityIdempotencyMiddleware(
  entityName: string,
  opName: string,
  config: Required<RouteIdempotencyConfig>,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const rawKey = c.req.header(HEADER_IDEMPOTENCY_KEY);
    if (!rawKey) {
      await next();
      return;
    }

    const slingshotCtx = getSlingshotCtx(c as unknown as Parameters<typeof getSlingshotCtx>[0]);
    const adapter = slingshotCtx.persistence.idempotency;
    const requestFingerprint = await buildRequestFingerprint(c);
    const derivedKey = buildScopedIdempotencyKey(rawKey, entityName, opName, c, config);

    const cached = await adapter.get(derivedKey);
    if (cached) {
      if (cached.requestFingerprint && cached.requestFingerprint !== requestFingerprint) {
        c.res = idempotencyConflictResponse(c);
        return;
      }
      c.res = replayStoredResponse(cached);
      return;
    }

    await next();

    const status = c.res.status;
    const payload = await captureResponsePayload(c.res);
    if (!payload) {
      return;
    }

    const responseHeaders = captureResponseHeaders(c.res);
    await adapter.set(derivedKey, payload.body, status, config.ttl, {
      requestFingerprint,
      responseHeaders,
      responseEncoding: payload.encoding,
    });

    const stored = await adapter.get(derivedKey);
    if (stored?.requestFingerprint && stored.requestFingerprint !== requestFingerprint) {
      c.res = idempotencyConflictResponse(c);
      return;
    }
    if (
      stored &&
      (stored.response !== payload.body ||
        JSON.stringify(stored.responseHeaders ?? null) !== JSON.stringify(responseHeaders))
    ) {
      c.res = replayStoredResponse(stored);
    }
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
  /** Legacy fallback bus for operation events when no registry-backed publisher is supplied. */
  bus?: SlingshotEventBus;
  /** Canonical registry-backed event publisher for operation events. */
  events?: SlingshotEvents;
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
  /**
   * Operation configs keyed by operation name. When provided, named-operation middleware
   * paths and methods are inferred from the actual operation kind so they stay aligned
   * with `buildBareEntityRoutes()`.
   */
  operationConfigs?: Record<string, OperationConfig>;
  /** Shared planned route set for generated routes, overrides, and extra routes. */
  plannedRoutes?: readonly PlannedEntityRoute[];
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
  const {
    bus,
    events,
    permissionEvaluator,
    permissionRegistry,
    rateLimitFactory,
    middleware: mw,
  } = deps;
  const plannedRoutes = deps.plannedRoutes;
  const entitySegment = deps.routePath ?? entityToPath(entityConfig.name);
  const path = deps.parentPath
    ? `${deps.parentPath.replace(/^\//, '')}/${entitySegment}`
    : entitySegment;

  // 1. Permission resource registration
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

  // 2. Webhook event key collection
  if (routeConfig.webhooks && deps.webhookEventKeys) {
    for (const eventKey of Object.keys(routeConfig.webhooks)) {
      deps.webhookEventKeys.push(eventKey);
    }
  }

  if (plannedRoutes && plannedRoutes.length > 0) {
    const eventMap = new Map<string, RouteEventConfig>();

    for (const route of plannedRoutes) {
      const opConfig = resolvePlannedRouteConfig(route, routeConfig);
      if (!opConfig) continue;

      const methods = new Set([route.method.toUpperCase()]);
      const opPath = route.path;
      const opName = route.opName;

      if (opConfig.rateLimit && rateLimitFactory) {
        router.use(opPath, methodGuard(methods, rateLimitFactory(opConfig.rateLimit)));
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

            if (opConfig.auth === 'userAuth' && slingshotCtx.routeAuth?.postGuards) {
              for (const guard of slingshotCtx.routeAuth.postGuards) {
                const failure = await guard(c);
                if (failure) {
                  return c.json({ error: failure.error, message: failure.message }, failure.status);
                }
              }
            }

            const hasPostFetchPolicyPass =
              route.generatedRouteKey === 'get' ||
              route.generatedRouteKey === 'update' ||
              route.generatedRouteKey === 'delete' ||
              route.generatedRouteKey === 'list';
            if (!hasPostFetchPolicyPass) {
              const policyConfig = resolvePolicyConfig(opConfig, routeConfig);
              if (policyConfig && deps.policyResolvers && policyAppliesToOp(policyConfig, opName)) {
                const policyResolver = deps.policyResolvers.get(
                  getPolicyResolverKey(policyConfig.resolver),
                );
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

      const idempotency = normalizeIdempotencyConfig(opConfig.idempotency);
      if (idempotency) {
        router.use(
          opPath,
          methodGuard(
            methods,
            createEntityIdempotencyMiddleware(entityConfig.name, opName, idempotency),
          ),
        );
      }

      if (opConfig.middleware && mw) {
        for (const name of opConfig.middleware) {
          const handler = (mw as Record<string, MiddlewareHandler | undefined>)[name];
          if (handler) router.use(opPath, methodGuard(methods, handler));
        }
      }

      if (opConfig.event) {
        const evt: RouteEventConfig =
          typeof opConfig.event === 'string'
            ? { key: opConfig.event, exposure: ['internal'] }
            : { exposure: ['internal'], ...opConfig.event };
        eventMap.set(route.routeKey, evt);
      }
    }

    if (eventMap.size > 0 && (events || bus)) {
      const capturedBus = bus;
      const capturedEvents = events;
      router.use('*', async (c, next) => {
        await next();
        // Reading c.res lazily creates a Response. When the chain didn't actually
        // finalize one (e.g. the request fell through to a route registered
        // elsewhere in the app), accessing .status crashes with RangeError on
        // status 0. Bail out before that happens.
        if (!c.finalized) return;
        let status: number;
        try {
          status = c.res.status;
        } catch {
          // Hono may throw when accessing .status on an uninitialised response — bail safely
          return;
        }
        if (status < 200 || status >= 300) return;

        const routeKey = c.get('__routeKey' as never) as string | undefined;
        const opName = c.get('__opName' as never) as string | undefined;
        const result = c.get('__opResult' as never) as Record<string, unknown> | undefined;
        if (!result) return;

        const evt =
          (routeKey ? eventMap.get(routeKey) : undefined) ??
          (opName ? eventMap.get(opName) : undefined);
        if (!evt) return;

        const payload: Record<string, unknown> = {};
        if (evt.payload && evt.payload.length > 0) {
          for (const f of evt.payload) payload[f] = result[f];
        } else {
          Object.assign(payload, result);
        }
        const requestTenantId = getRequestTenantId(c);
        for (const includeField of evt.include ?? []) {
          const actor = getActor(c);
          switch (includeField) {
            case 'tenantId':
              payload.tenantId = requestTenantId;
              break;
            case 'actorId':
              payload.actorId = actor.id;
              break;
            case 'requestId':
              payload.requestId = c.get('requestId');
              break;
            case 'ip':
              payload.ip = c.req.header('x-forwarded-for') ?? null;
              break;
          }
        }
        if (capturedEvents) {
          const actor = getActor(c);
          const actorId = actor.kind === 'anonymous' ? undefined : actor.id;
          capturedEvents.publish(evt.key as keyof SlingshotEventMap, payload, {
            userId: actor.kind === 'user' ? actor.id : undefined,
            actorId,
            requestTenantId,
            requestId: c.get('requestId') as string | undefined,
            correlationId: c.get('requestId') as string | undefined,
            source: 'http',
          });
          return;
        }
        (capturedBus as unknown as { emit(key: string, payload: unknown): void })?.emit(
          evt.key,
          payload,
        );
      });
    }

    return;
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
  const eventMap = new Map<string, RouteEventConfig>();

  for (const opName of allOpNames) {
    if (disabledOps.has(opName)) continue;

    const opConfig = resolveOpConfig(routeConfig, opName);
    if (!opConfig) continue;

    const isCrudOp = ['create', 'list', 'get', 'update', 'delete'].includes(opName);
    const namedRoute = isCrudOp
      ? undefined
      : resolveNamedOperationRoute(opName, deps.operationConfigs?.[opName], {
          method: routeConfig.operations?.[opName]?.method,
          path: routeConfig.operations?.[opName]?.path,
        });
    let paths: string[];
    let methods: Set<string>;
    if (isCrudOp) {
      paths = getOpPaths(path, opName);
      methods = opMethods(opName);
    } else {
      if (!namedRoute) continue;
      paths = [`/${path}/${namedRoute.path}`];
      methods = new Set([namedRoute.method.toUpperCase()]);
    }

    for (const opPath of paths) {
      // Rate limit middleware
      if (opConfig.rateLimit && rateLimitFactory) {
        router.use(opPath, methodGuard(methods, rateLimitFactory(opConfig.rateLimit)));
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
            if (opConfig.auth === 'userAuth' && slingshotCtx.routeAuth?.postGuards) {
              for (const guard of slingshotCtx.routeAuth.postGuards) {
                const failure = await guard(c);
                if (failure) {
                  return c.json({ error: failure.error, message: failure.message }, failure.status);
                }
              }
            }
            const hasPostFetchPolicyPass = SKIP_PRE_HANDLER_POLICY_OPS.has(opName);
            if (!hasPostFetchPolicyPass) {
              const policyConfig = resolvePolicyConfig(opConfig, routeConfig);
              if (policyConfig && deps.policyResolvers && policyAppliesToOp(policyConfig, opName)) {
                const policyResolver = deps.policyResolvers.get(
                  getPolicyResolverKey(policyConfig.resolver),
                );
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

      const idempotency = normalizeIdempotencyConfig(opConfig.idempotency);
      if (idempotency) {
        router.use(
          opPath,
          methodGuard(
            methods,
            createEntityIdempotencyMiddleware(entityConfig.name, opName, idempotency),
          ),
        );
      }

      // Custom middleware
      if (opConfig.middleware && mw) {
        for (const name of opConfig.middleware) {
          const handler = (mw as Record<string, MiddlewareHandler | undefined>)[name];
          if (handler) router.use(opPath, methodGuard(methods, handler));
        }
      }

      // Collect events for after-response middleware
      collectOpEvent(opConfig, opName, eventMap);
    }
  }

  // 5. Event emission — after-response middleware
  if (eventMap.size > 0 && (events || bus)) {
    const capturedBus = bus;
    const capturedEvents = events;
    router.use('*', async (c, next) => {
      await next();
      if (c.res.status < 200 || c.res.status >= 300) return;

      const opName = c.get('__opName' as never) as string | undefined;
      const result = c.get('__opResult' as never) as Record<string, unknown> | undefined;
      if (!opName || !result) return;

      const evt = eventMap.get(opName);
      if (!evt) return;

      const payload: Record<string, unknown> = {};
      if (evt.payload && evt.payload.length > 0) {
        for (const f of evt.payload) payload[f] = result[f];
      } else {
        Object.assign(payload, result);
      }
      const requestTenantId = getRequestTenantId(c);
      for (const includeField of evt.include ?? []) {
        const actor = getActor(c);
        switch (includeField) {
          case 'tenantId':
            payload.tenantId = requestTenantId;
            break;
          case 'actorId':
            payload.actorId = actor.id;
            break;
          case 'requestId':
            payload.requestId = c.get('requestId');
            break;
          case 'ip':
            payload.ip = c.req.header('x-forwarded-for') ?? null;
            break;
        }
      }
      if (capturedEvents) {
        const actor = getActor(c);
        const actorId = actor.kind === 'anonymous' ? undefined : actor.id;
        capturedEvents.publish(evt.key as keyof SlingshotEventMap, payload, {
          userId: actor.kind === 'user' ? actor.id : undefined,
          actorId,
          requestTenantId,
          requestId: c.get('requestId') as string | undefined,
          correlationId: c.get('requestId') as string | undefined,
          source: 'http',
        });
        return;
      }
      (capturedBus as unknown as { emit(key: string, payload: unknown): void })?.emit(
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
  eventMap: Map<string, RouteEventConfig>,
): void {
  if (!opConfig.event) return;
  const evt: RouteEventConfig =
    typeof opConfig.event === 'string'
      ? { key: opConfig.event, exposure: ['internal'] }
      : { exposure: ['internal'], ...opConfig.event };
  eventMap.set(opName, evt);
}

function resolvePlannedRouteConfig(
  route: PlannedEntityRoute,
  routeConfig: EntityRouteConfig,
): RouteOperationConfig | undefined {
  if (route.kind === 'extra') {
    return route.routeConfig;
  }

  return resolveOpConfig(routeConfig, route.opName) ?? route.routeConfig;
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
