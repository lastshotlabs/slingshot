/**
 * Build a live Hono router with bare CRUD + named operation handlers for an entity.
 *
 * Used by createEntityPlugin() at runtime — the router has no auth/permissions/etc.
 * Those are layered on top by applyRouteConfig().
 *
 * Route handler shape mirrors the generated code in generators/routes.ts:
 * - Sets c.set('__opName', ...) and c.set('__opResult', ...) so the event
 *   emission middleware registered by applyRouteConfig can read the result.
 */
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Handler } from 'hono';
import { z } from 'zod';
import type {
  AppEnv,
  EntityRouteDataScopeConfig,
  EntityRoutePolicyConfig,
  NamedOpHttpMethod,
  OperationConfig,
  PolicyResolver,
  ResolvedEntityConfig,
  SlingshotEventBus,
} from '@lastshotlabs/slingshot-core';
import { entityToPath } from '../generators/routeHelpers';
import { buildEntityZodSchemas } from '../lib/entityZodSchemas';
import { policyAppliesToOp, resolvePolicy } from '../policy/resolvePolicy';
import { resolveNamedOperationRoute } from './namedOperationRouting';
import { findScopedFieldInBody, normalizeDataScopes, resolveDataScopes } from './resolveDataScope';

/**
 * The typed CRUD surface of a bare entity adapter.
 *
 * Each method mirrors the HTTP verb and semantics used by the generated routes:
 * - `create` → POST `/{segment}` → 201
 * - `getById` → GET `/{segment}/:id` → 200 | 404
 * - `list` → GET `/{segment}` → 200 (with optional cursor pagination)
 * - `update` → PATCH `/{segment}/:id` → 200 | 404
 * - `delete` → DELETE `/{segment}/:id` → 204
 *
 * @example
 * ```ts
 * import type { BareEntityAdapterCrud } from '@lastshotlabs/slingshot-entity/routing';
 *
 * // Implementing a minimal in-memory adapter for testing:
 * const store = new Map<string, unknown>();
 * const adapter: BareEntityAdapterCrud = {
 *   async create(data) { const id = crypto.randomUUID(); store.set(id, data); return { id, ...data as object }; },
 *   async getById(id)  { return store.get(id) ?? null; },
 *   async list()       { return { items: [...store.values()] }; },
 *   async update(id, data) { const item = { ...store.get(id) as object, ...data as object }; store.set(id, item); return item; },
 *   async delete(id)   { store.delete(id); },
 * };
 * ```
 */
export interface BareEntityAdapterCrud {
  create(data: unknown): Promise<unknown>;
  getById(id: string, filter?: Record<string, unknown>): Promise<unknown>;
  list(opts: {
    filter?: unknown;
    limit?: number;
    cursor?: string;
    sortDir?: 'asc' | 'desc';
  }): Promise<{ items: unknown[]; cursor?: string; nextCursor?: string; hasMore?: boolean }>;
  update(id: string, data: unknown, filter?: Record<string, unknown>): Promise<unknown>;
  delete(id: string, filter?: Record<string, unknown>): Promise<boolean>;
}

/**
 * A full entity adapter: typed CRUD methods plus a dynamic index for named
 * operation methods (e.g. `adapter.byRoom(input)`).
 *
 * Produced by `EntityPluginEntry.buildAdapter()` and consumed by
 * `buildBareEntityRoutes()`.
 *
 * @example
 * ```ts
 * import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
 * import { createEntityFactories, resolveRepo } from '@lastshotlabs/slingshot-core';
 * import { Message, MessageOps } from './message';
 *
 * // Typically resolved via EntityPluginEntry.buildAdapter():
 * const adapter: BareEntityAdapter = resolveRepo(
 *   createEntityFactories(Message, MessageOps.operations),
 *   storeType,
 *   infra,
 * );
 * // adapter.create(data)        — CRUD method
 * // adapter.byRoom(input)       — named operation method
 * ```
 */
export type BareEntityAdapter = BareEntityAdapterCrud & { [key: string]: unknown };

type OperationFunction = (...args: unknown[]) => Promise<unknown>;
type RouteDefinition = ReturnType<typeof createRoute>;
type OpenApiRouteRegistrar = {
  openapi(route: RouteDefinition, handler: Handler): unknown;
};
type BareRouteRegistrar = {
  delete(path: string, handler: Handler): unknown;
  get(path: string, handler: Handler): unknown;
  patch(path: string, handler: Handler): unknown;
  post(path: string, handler: Handler): unknown;
  put(path: string, handler: Handler): unknown;
};
type BareEntityRouteRegistrar = BareRouteRegistrar & Partial<OpenApiRouteRegistrar>;

function supportsOpenApi(
  router: BareEntityRouteRegistrar,
): router is BareEntityRouteRegistrar & OpenApiRouteRegistrar {
  return typeof router.openapi === 'function';
}

function registerRoute(
  router: BareEntityRouteRegistrar,
  route: RouteDefinition,
  handler: Handler,
): void {
  if (route.method === 'head') {
    const headOnlyHandler: Handler = async c => {
      if (c.req.method !== 'HEAD') {
        return c.json({ error: 'Not found' }, 404) as never;
      }
      return handler(c);
    };
    if (supportsOpenApi(router)) {
      router.openapi(route, headOnlyHandler);
    }
    router.get(route.path, headOnlyHandler);
    return;
  }
  if (supportsOpenApi(router)) {
    router.openapi(route, handler);
    return;
  }
  switch (route.method) {
    case 'get':
      router.get(route.path, handler);
      return;
    case 'post':
      router.post(route.path, handler);
      return;
    case 'put':
      router.put(route.path, handler);
      return;
    case 'patch':
      router.patch(route.path, handler);
      return;
    case 'delete':
      router.delete(route.path, handler);
      return;
    default:
      throw new Error(`Unsupported bare entity route method: ${route.method}`);
  }
}

function readRequiredParam(c: Parameters<Handler>[0], key: string): string {
  const value = c.req.param(key);
  if (typeof value !== 'string') {
    throw new Error(`Missing required route param '${key}'`);
  }
  return value;
}

function resolveOperationValue(
  value: string | undefined,
  params: Record<string, unknown>,
): unknown {
  if (value === undefined) return undefined;
  const prefixes = ['param:', 'input:', 'ctx:'];
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) return params[value.slice(prefix.length)];
  }
  return value;
}

function coerceOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

async function invokeNamedOperation(
  opConfig: OperationConfig,
  opFn: OperationFunction,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (opConfig.kind) {
    case 'fieldUpdate':
      return opFn(params, params);
    case 'arrayPush':
    case 'arrayPull':
    case 'arraySet':
      return opFn(params.id, resolveOperationValue(opConfig.value, params));
    case 'increment':
      return opFn(params.id, coerceOptionalNumber(params.by));
    case 'search': {
      const rawQ = params.q ?? params.query ?? '';
      const queryStr = typeof rawQ === 'string' ? rawQ : String(rawQ as string | number | boolean);
      return opFn(
        queryStr,
        params,
        coerceOptionalNumber(params.limit),
        typeof params.cursor === 'string' ? params.cursor : undefined,
      );
    }
    default:
      return opFn(params);
  }
}

function routeDisabled(
  disabled: ReadonlySet<string>,
  opName: string,
  method: string,
  path: string,
): boolean {
  const normalizedMethod = method.toUpperCase();
  const openApiPath = path.replace(/:([A-Za-z]\w*)/g, '{$1}');
  return (
    disabled.has(opName) ||
    disabled.has(`${normalizedMethod} ${path}`) ||
    disabled.has(`${normalizedMethod} ${openApiPath}`)
  );
}

/**
 * Build a Hono router with bare CRUD and named operation handlers for an entity.
 *
 * Registers the following routes on the returned (or provided) router:
 * - `POST   /{segment}` — create
 * - `GET    /{segment}` — list
 * - `GET    /{segment}/:id` — get
 * - `PATCH  /{segment}/:id` — update
 * - `DELETE /{segment}/:id` — delete
 * - One route per named operation, with verb/path inferred from the operation kind
 *   (for example `lookup` → `GET /{segment}/{op}/{params}`, `exists` → `HEAD ...`)
 *
 * Route handlers set `c.set('__opName', ...)` and `c.set('__opResult', ...)`
 * so that the event emission middleware registered by `applyRouteConfig()` can
 * read the operation result and emit declared events.
 *
 * @param config - Resolved entity config (used to derive the URL segment).
 * @param operations - Named operations to register as routes.
 * @param adapter - The runtime adapter that implements CRUD and operation methods.
 * @param existingRouter - Optional existing router to add routes to. When
 *   omitted, a new `OpenAPIHono` is created.
 * @param options - Optional overrides.
 * @param options.routePath - URL path segment override. When set, replaces
 *   `entityToPath(config.name)`. Must match the segment used by `applyRouteConfig`
 *   (via `RouteConfigDeps.routePath`) or middleware will not fire.
 * @param options.parentPath - Parent path prefix (e.g. `'/documents/:id'`). When set,
 *   all routes are mounted under `parentPath/segment`. Must match
 *   `RouteConfigDeps.parentPath` passed to `applyRouteConfig`.
 * @param options.operationMethods - HTTP method overrides for named operations.
 *   Keys are operation names; values are `NamedOpHttpMethod`. Method resolution priority:
 *   `operationMethods[opName]` → `op.custom http.method` → inferred default by op kind.
 * @param options.operationPaths - URL path segment overrides for named operations.
 *   Keys are operation names; values are path strings (e.g. `':id/revert'`).
 *   Priority: `operationPaths[opName]` → `op.custom http.path` → inferred default path.
 *   Path params declared in the override (e.g. `:id`) are injected into the operation
 *   params alongside body fields and context values.
 * @param options.dataScope - Optional row-level isolation bindings for standard CRUD
 *   routes. When set, create writes the scoped field from the resolved source, list
 *   passes the resolved bindings as an adapter filter, and get/update/delete pass the
 *   bindings as an atomic adapter filter so scope mismatches return 404 instead of
 *   leaking record existence. Update rejects any body that tries to set a scoped field
 *   with `{ error: 'scoped_field_immutable', field }`.
 *
 * @remarks
 * **Context injection:** Before calling each named operation handler, the following
 * values are merged into the params object passed to the adapter method. Merge priority
 * is body < path params < context overrides:
 * - Body fields — from the parsed JSON request body (lowest priority)
 * - Path params — from URL path parameters (e.g. `:id` in `operationPaths` or `op.custom http.path`)
 * - `tenantId` — from `c.get('tenantId')` (set by tenant middleware)
 * - `authUserId` — from `c.get('authUserId')` (set by auth middleware)
 *
 * This allows transaction step bindings like `'param:authUserId'`, `'param:tenantId'`,
 * and `'param:id'` to resolve from server-side context or URL params rather than
 * requiring the client to supply them in the request body. Context values always win —
 * clients cannot override them.
 * @returns The router (either `existingRouter` or the newly created one).
 *
 * @remarks
 * This function registers **only** route handlers — no auth, permissions, or
 * rate limiting. Use `applyRouteConfig()` before or after to layer those on.
 * In `createEntityPlugin()`, `applyRouteConfig()` is called first so its
 * middleware runs before these handlers.
 *
 * @example
 * ```ts
 * import { buildBareEntityRoutes } from '@lastshotlabs/slingshot-entity/routing';
 * import { OpenAPIHono } from '@hono/zod-openapi';
 *
 * const router = buildBareEntityRoutes(Message, MessageOps.operations, adapter);
 * app.route('/api', router);
 * ```
 */
export function buildBareEntityRoutes<
  RouterT extends BareEntityRouteRegistrar = OpenAPIHono<AppEnv>,
>(
  config: ResolvedEntityConfig,
  operations: Record<string, OperationConfig> | undefined,
  adapter: BareEntityAdapter,
  existingRouter?: RouterT,
  options?: {
    routePath?: string;
    parentPath?: string;
    operationMethods?: Record<string, NamedOpHttpMethod>;
    operationPaths?: Record<string, string>;
    dataScope?: EntityRouteDataScopeConfig | readonly EntityRouteDataScopeConfig[];
    /** Policy config from the entity route config (for post-fetch pass). */
    policyConfig?: EntityRoutePolicyConfig;
    /** Resolved policy resolver (for post-fetch pass). */
    policyResolver?: PolicyResolver;
    /** Event bus for emitting policy denial events. */
    bus?: SlingshotEventBus;
    /** Override the OpenAPI tag for all routes. Defaults to entity name. */
    tag?: string;
  },
): RouterT | OpenAPIHono<AppEnv> {
  const router = existingRouter ?? new OpenAPIHono<AppEnv>();
  const entitySegment = options?.routePath ?? entityToPath(config.name);
  const segment = options?.parentPath
    ? `${options.parentPath.replace(/^\//, '')}/${entitySegment}`
    : entitySegment;
  const schemas = buildEntityZodSchemas(config);
  const disabled = new Set(config.routes?.disable ?? []);
  const tag = options?.tag ?? config.name;
  const dataScopes = normalizeDataScopes(options?.dataScope ?? config.routes?.dataScope);
  const policyConfig = options?.policyConfig;
  const policyResolver = options?.policyResolver;
  const policyBus = options?.bus;
  const errorSchema = z.object({ error: z.string() });

  // Named operations are registered BEFORE CRUD routes so that static paths
  // (e.g. /notes/list-by-document) take precedence over the dynamic GET /notes/:id
  // route when a named op uses method 'get'.
  for (const [opName, opConfig] of Object.entries(operations ?? {})) {
    const route = resolveNamedOperationRoute(opName, opConfig, {
      method: options?.operationMethods?.[opName],
      path: options?.operationPaths?.[opName],
    });
    const opPath = `/${segment}/${route.path}`;
    if (routeDisabled(disabled, opName, route.method, opPath)) continue;
    const routeParams =
      opConfig.kind === 'lookup' || opConfig.kind === 'exists'
        ? [...new Set(opPath.match(/:([A-Za-z]\w*)/g)?.map(param => param.slice(1)) ?? [])]
        : [];
    const request =
      routeParams.length > 0
        ? {
            params: z.object(Object.fromEntries(routeParams.map(param => [param, z.string()]))),
          }
        : undefined;
    const responses =
      opConfig.kind === 'lookup'
        ? opConfig.returns === 'one'
          ? {
              200: {
                content: { 'application/json': { schema: schemas.entity } },
                description: 'Found',
              },
              404: {
                content: { 'application/json': { schema: errorSchema } },
                description: 'Not found',
              },
            }
          : {
              200: {
                content: { 'application/json': { schema: schemas.list } },
                description: 'List result',
              },
            }
        : opConfig.kind === 'exists'
          ? {
              200: { description: 'Exists' },
              404: { description: 'Not found' },
            }
          : {
              200: {
                content: { 'application/json': { schema: schemas.entity } },
                description: 'OK',
              },
            };
    const opRoute = createRoute({
      method: route.method,
      path: opPath,
      tags: [tag],
      summary: opName,
      ...(request ? { request } : {}),
      responses,
    });
    registerRoute(router, opRoute, async c => {
      // GET requests may carry no JSON body — fall back to empty object so
      // the operation receives a defined (albeit empty) input.
      let input: unknown = {};
      try {
        input = (await c.req.json()) as unknown;
      } catch {
        // no body
      }
      // Inject well-known context values so transaction param bindings (e.g.
      // 'param:authUserId', 'param:tenantId') can resolve from auth/tenant
      // middleware without requiring the client to supply them in the body.
      // Merge priority: body < path params < context overrides.
      // Context values always win — clients cannot spoof them.
      const bodyRecord =
        typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
      // Path params (e.g. :id from op.custom http.path) come after body so URL-encoded
      // values take precedence over body fields of the same name.
      const pathParams = c.req.param() as Record<string, string>;
      const queryParams = Object.fromEntries(new URL(c.req.url).searchParams.entries());
      // Context values override both body and path params — clients cannot spoof them.
      const tenantId = c.get('tenantId' as never) as string | null | undefined;
      const authUserId = c.get('authUserId' as never) as string | null | undefined;
      const ctxOverrides: Record<string, unknown> = {};
      if (tenantId != null) ctxOverrides.tenantId = tenantId;
      if (authUserId != null) ctxOverrides.authUserId = authUserId;
      const params = { ...queryParams, ...bodyRecord, ...pathParams, ...ctxOverrides };

      const opFn = adapter[opName];
      if (typeof opFn !== 'function') {
        return c.json({ error: `Operation ${opName} not found` }, 404) as never;
      }
      const result = await invokeNamedOperation(opConfig, opFn as OperationFunction, params);
      c.set('__opName' as never, opName as never);
      c.set('__opResult' as never, result as never);
      if (opConfig.kind === 'lookup' && opConfig.returns === 'one') {
        if (!result) return c.json({ error: 'Not found' }, 404) as never;
        return c.json(result, 200);
      }
      if (opConfig.kind === 'exists') {
        return result ? c.body(null, 200) : c.body(null, 404);
      }
      return c.json(result, 200);
    });
  }

  // POST /{segment} — create
  if (!routeDisabled(disabled, 'create', 'POST', `/${segment}`)) {
    registerRoute(
      router,
      createRoute({
        method: 'post',
        path: `/${segment}`,
        tags: [tag],
        summary: `Create ${config.name}`,
        request: { body: { content: { 'application/json': { schema: schemas.create } } } },
        responses: {
          201: {
            content: { 'application/json': { schema: schemas.entity } },
            description: 'Created',
          },
        },
      }),
      async c => {
        const input = (await c.req.json()) as unknown;
        const bodyRecord =
          typeof input === 'object' && input !== null
            ? { ...(input as Record<string, unknown>) }
            : {};

        if (dataScopes.length > 0) {
          const resolution = resolveDataScopes(dataScopes, 'create', c);
          if (resolution.status === 'missing') {
            return c.json(
              { error: `dataScope source '${resolution.source}' not set on request context` },
              401,
            ) as never;
          }
          Object.assign(bodyRecord, resolution.bindings);
        }

        const result = await adapter.create(bodyRecord);
        c.set('__opName' as never, 'create' as never);
        c.set('__opResult' as never, result as never);
        return c.json(result, 201);
      },
    );
  }

  // GET /{segment} — list
  if (!routeDisabled(disabled, 'list', 'GET', `/${segment}`)) {
    registerRoute(
      router,
      createRoute({
        method: 'get',
        path: `/${segment}`,
        tags: [tag],
        summary: `List ${config.name}`,
        request: { query: schemas.listOptions },
        responses: {
          200: { content: { 'application/json': { schema: schemas.list } }, description: 'OK' },
        },
      }),
      async c => {
        const rawQuery = Object.fromEntries(new URL(c.req.url).searchParams.entries());
        const parsedQuery = schemas.listOptions.safeParse(rawQuery);
        if (!parsedQuery.success) {
          return c.json(
            {
              success: false,
              error: { name: 'ZodError', message: parsedQuery.error.message },
            },
            400,
          ) as never;
        }

        const { limit, cursor, sortDir, ...validatedFilters } = parsedQuery.data as Record<
          string,
          unknown
        > & {
          limit?: number;
          cursor?: string;
          sortDir?: 'asc' | 'desc';
        };
        let filter = Object.keys(validatedFilters).length > 0 ? { ...validatedFilters } : undefined;

        if (dataScopes.length > 0) {
          const resolution = resolveDataScopes(dataScopes, 'list', c);
          if (resolution.status === 'missing') {
            return c.json(
              { error: `dataScope source '${resolution.source}' not set on request context` },
              401,
            ) as never;
          }
          filter = { ...(filter ?? {}), ...resolution.bindings };
        }

        const listOpts: {
          filter?: Record<string, unknown>;
          limit?: number;
          cursor?: string;
          sortDir?: 'asc' | 'desc';
        } = {};
        if (filter) listOpts.filter = filter;
        if (limit !== undefined) listOpts.limit = limit;
        if (cursor !== undefined) listOpts.cursor = cursor;
        if (sortDir !== undefined) listOpts.sortDir = sortDir;

        const result = await adapter.list(listOpts);
        c.set('__opName' as never, 'list' as never);
        c.set('__opResult' as never, result as never);
        return c.json(result, 200);
      },
    );
  }

  // GET /{segment}/:id — get
  if (!routeDisabled(disabled, 'get', 'GET', `/${segment}/:id`)) {
    registerRoute(
      router,
      createRoute({
        method: 'get',
        path: `/${segment}/:id`,
        tags: [tag],
        summary: `Get ${config.name} by ID`,
        responses: {
          200: { content: { 'application/json': { schema: schemas.entity } }, description: 'OK' },
          404: {
            content: { 'application/json': { schema: z.object({ error: z.string() }) } },
            description: 'Not found',
          },
        },
      }),
      async c => {
        const id = readRequiredParam(c, 'id');
        let filter: Record<string, unknown> | undefined;

        if (dataScopes.length > 0) {
          const resolution = resolveDataScopes(dataScopes, 'get', c);
          if (resolution.status === 'missing') {
            return c.json(
              { error: `dataScope source '${resolution.source}' not set on request context` },
              401,
            ) as never;
          }
          filter = resolution.bindings;
        }

        const result = await adapter.getById(id, filter);
        if (!result) return c.json({ error: 'Not found' }, 404) as never;

        // Post-fetch policy pass — record-dependent authorization.
        if (policyConfig && policyResolver && policyAppliesToOp(policyConfig, 'get')) {
          await resolvePolicy({
            c,
            config: policyConfig,
            resolver: policyResolver,
            action: { kind: 'get' },
            record: result,
            input: null,
            bus: policyBus,
          });
        }

        c.set('__opName' as never, 'get' as never);
        c.set('__opResult' as never, result as never);
        return c.json(result, 200);
      },
    );
  }

  // PATCH /{segment}/:id — update (using PATCH to match generated routes.ts)
  if (!routeDisabled(disabled, 'update', 'PATCH', `/${segment}/:id`)) {
    registerRoute(
      router,
      createRoute({
        method: 'patch',
        path: `/${segment}/:id`,
        tags: [tag],
        summary: `Update ${config.name}`,
        request: { body: { content: { 'application/json': { schema: schemas.update } } } },
        responses: {
          200: { content: { 'application/json': { schema: schemas.entity } }, description: 'OK' },
          404: {
            content: { 'application/json': { schema: z.object({ error: z.string() }) } },
            description: 'Not found',
          },
        },
      }),
      async c => {
        const id = readRequiredParam(c, 'id');
        const input = (await c.req.json()) as unknown;
        const bodyRecord =
          typeof input === 'object' && input !== null
            ? { ...(input as Record<string, unknown>) }
            : {};

        if (dataScopes.length > 0) {
          const offending = findScopedFieldInBody(dataScopes, bodyRecord);
          if (offending !== null) {
            return c.json({ error: 'scoped_field_immutable', field: offending }, 400) as never;
          }
        }

        let filter: Record<string, unknown> | undefined;
        if (dataScopes.length > 0) {
          const resolution = resolveDataScopes(dataScopes, 'update', c);
          if (resolution.status === 'missing') {
            return c.json(
              { error: `dataScope source '${resolution.source}' not set on request context` },
              401,
            ) as never;
          }
          filter = resolution.bindings;
        }

        // For update, we need the existing record for the post-fetch policy pass.
        // Fetch it before writing if policy is configured.
        if (policyConfig && policyResolver && policyAppliesToOp(policyConfig, 'update')) {
          const existing = await adapter.getById(id, filter);
          if (!existing) return c.json({ error: 'Not found' }, 404) as never;
          await resolvePolicy({
            c,
            config: policyConfig,
            resolver: policyResolver,
            action: { kind: 'update' },
            record: existing,
            input: bodyRecord,
            bus: policyBus,
          });
        }

        const result = await adapter.update(id, bodyRecord, filter);
        if (!result) return c.json({ error: 'Not found' }, 404) as never;
        c.set('__opName' as never, 'update' as never);
        c.set('__opResult' as never, result as never);
        return c.json(result, 200);
      },
    );
  }

  // DELETE /{segment}/:id — delete
  if (!routeDisabled(disabled, 'delete', 'DELETE', `/${segment}/:id`)) {
    registerRoute(
      router,
      createRoute({
        method: 'delete',
        path: `/${segment}/:id`,
        tags: [tag],
        summary: `Delete ${config.name}`,
        responses: { 204: { description: 'Deleted' } },
      }),
      async c => {
        const id = readRequiredParam(c, 'id');
        let filter: Record<string, unknown> | undefined;

        if (dataScopes.length > 0) {
          const resolution = resolveDataScopes(dataScopes, 'delete', c);
          if (resolution.status === 'missing') {
            return c.json(
              { error: `dataScope source '${resolution.source}' not set on request context` },
              401,
            ) as never;
          }
          filter = resolution.bindings;
        }

        // Post-fetch policy pass for delete — need to fetch the record first.
        if (policyConfig && policyResolver && policyAppliesToOp(policyConfig, 'delete')) {
          const existing = await adapter.getById(id, filter);
          if (!existing) return c.json({ error: 'Not found' }, 404) as never;
          await resolvePolicy({
            c,
            config: policyConfig,
            resolver: policyResolver,
            action: { kind: 'delete' },
            record: existing,
            input: null,
            bus: policyBus,
          });
        }

        const ok = await adapter.delete(id, filter);
        if (!ok) return c.json({ error: 'Not found' }, 404) as never;
        c.set('__opName' as never, 'delete' as never);
        return c.body(null, 204);
      },
    );
  }

  return router;
}
