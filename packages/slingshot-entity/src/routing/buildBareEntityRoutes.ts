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
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context, Handler } from 'hono';
import { type ZodTypeAny, z } from 'zod';
import type {
  AppEnv,
  EntityRouteDataScopeConfig,
  EntityRoutePolicyConfig,
  NamedOpHttpMethod,
  OperationConfig,
  PackageRouteRequestContext,
  PolicyResolver,
  ResolvedEntityConfig,
  SlingshotEventBus,
  TypedRouteRequestSpec,
  TypedRouteResponseSpec,
  TypedRouteResponses,
} from '@lastshotlabs/slingshot-core';
import { createRoute, getActor } from '@lastshotlabs/slingshot-core';
import { entityToPath } from '../generators/routeHelpers';
import { buildEntityZodSchemas } from '../lib/entityZodSchemas';
import { policyAppliesToOp, resolvePolicy } from '../policy/resolvePolicy';
import type { BareEntityAdapter } from './adapterTypes';
import type {
  EntityRouteExecutionContext,
  EntityRouteExecutor,
  EntityRouteExecutorBuilderContext,
  PlannedEntityRoute,
} from './entityRoutePlanning';
import { resolveNamedOperationRoute } from './namedOperationRouting';
import { findScopedFieldInBody, normalizeDataScopes, resolveDataScopes } from './resolveDataScope';

export type { BareEntityAdapter, BareEntityAdapterCrud } from './adapterTypes';

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
      return handler(c, async () => {});
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
    if (!value.startsWith(prefix)) continue;
    const key = value.slice(prefix.length);
    return params[key];
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

type PlannedRouteOptions = {
  getEntityAdapter?: (args: { plugin: string; entity: string }) => BareEntityAdapter;
  plannedRoutes?: readonly PlannedEntityRoute[];
};

type PlannedExecutionPrep = {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  input: unknown;
  requestContext: PackageRouteRequestContext;
  filter?: Record<string, unknown>;
  dataScopeBindings?: Record<string, unknown>;
  existingRecord?: unknown;
};

function readJsonRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null
    ? { ...(input as Record<string, unknown>) }
    : {};
}

function buildRequestContext(c: Context<AppEnv>): PackageRouteRequestContext {
  const actor = getActor(c);
  return {
    actor,
    requestId: c.get('requestId' as never) as string | undefined,
  };
}

function normalizeTypedInput(
  body: unknown,
  query: Record<string, unknown>,
  params: Record<string, string>,
): unknown {
  if (body === null || body === undefined) {
    const merged = { ...query, ...params };
    return Object.keys(merged).length > 0 ? merged : null;
  }
  if (typeof body !== 'object') {
    return body;
  }
  if (Array.isArray(body)) {
    return body;
  }
  const merged = { ...query, ...params, ...asObjectRecord(body) };
  return Object.keys(merged).length > 0 ? merged : null;
}

function asObjectRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function validationErrorResponse(c: Context<AppEnv>, error: z.ZodError): Response {
  return c.json(
    {
      success: false,
      error: { name: 'ZodError', message: error.message },
    },
    400,
  );
}

function parseTypedSection(
  c: Context<AppEnv>,
  schema: ZodTypeAny | undefined,
  input: unknown,
): { success: true; data: unknown } | { success: false; response: Response } {
  if (!schema) {
    return {
      success: true,
      data: input,
    };
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { success: false, response: validationErrorResponse(c, parsed.error) };
  }
  return {
    success: true,
    data: parsed.data,
  };
}

function buildTypedRouteRequest(
  request: TypedRouteRequestSpec | undefined,
): Parameters<typeof createRoute>[0]['request'] | undefined {
  if (!request) return undefined;
  const built: NonNullable<Parameters<typeof createRoute>[0]['request']> = {};
  if (request.params) {
    built.params = request.params as never;
  }
  if (request.query) {
    built.query = request.query as never;
  }
  if (request.body) {
    built.body = { content: { 'application/json': { schema: request.body } } };
  }
  return Object.keys(built).length > 0 ? built : undefined;
}

function buildTypedRouteResponses(
  responses: TypedRouteResponses | undefined,
  fallback: Parameters<typeof createRoute>[0]['responses'],
): Parameters<typeof createRoute>[0]['responses'] {
  if (!responses || Object.keys(responses).length === 0) {
    return fallback;
  }
  const built = Object.fromEntries(
    Object.entries(responses).map(([status, response]) => [status, buildTypedResponse(response)]),
  );
  return built as Parameters<typeof createRoute>[0]['responses'];
}

function buildTypedResponse(
  response: TypedRouteResponseSpec,
): NonNullable<Parameters<typeof createRoute>[0]['responses']>[number] {
  const contentType = response.contentType ?? 'application/json';
  if (!response.schema) {
    return { description: response.description };
  }
  return {
    description: response.description,
    content: {
      [contentType]: {
        schema: response.schema,
      },
    },
  };
}

function stripPrivateFields(value: unknown, privateFields: Set<string>): unknown {
  if (privateFields.size === 0) return value;
  if (Array.isArray(value)) {
    return value.map(item => stripPrivateFields(item, privateFields));
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Paginated shape: { items: [...], nextCursor, ... } — recurse into items.
    if (Array.isArray(obj.items)) {
      return {
        ...obj,
        items: obj.items.map(item => stripPrivateFields(item, privateFields)),
      };
    }
    // Plain record: drop private keys at the top level.
    const out: Record<string, unknown> = {};
    let stripped = false;
    for (const [k, v] of Object.entries(obj)) {
      if (privateFields.has(k)) {
        stripped = true;
        continue;
      }
      out[k] = v;
    }
    return stripped ? out : value;
  }
  return value;
}

/**
 * Apply entity-level response projection: strip `private: true` fields, then
 * apply the selected `dto` mapper if present. The variant name selects which
 * mapper from `config.dto` to apply (`'default'` when unset).
 *
 * Used for both the planned-route path and the legacy direct-handler path.
 */
const warnedUnknownVariants = new Set<string>();

function applyEntityProjection(
  data: unknown,
  config: ResolvedEntityConfig,
  variant?: string,
): unknown {
  const privateFields = new Set<string>();
  for (const [name, def] of Object.entries(config.fields)) {
    if (def.private) privateFields.add(name);
  }
  let value = stripPrivateFields(data, privateFields);
  const variantKey = variant ?? 'default';
  const mapper = config.dto?.[variantKey];
  if (!mapper) {
    // Warn once per (entity, variant) when an explicit variant name was
    // provided but no matching mapper exists in `config.dto`. Silent fall-through
    // would mean the route returns raw records, which is almost certainly a typo.
    if (variant) {
      const warnKey = `${config.name}:${variant}`;
      if (!warnedUnknownVariants.has(warnKey)) {
        warnedUnknownVariants.add(warnKey);
        const available = Object.keys(config.dto ?? {});
        console.warn(
          `[slingshot] Unknown DTO variant '${variant}' on entity '${config.name}'. ` +
            `Available: [${available.join(', ') || '(none)'}]. Falling through to no projection.`,
        );
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item =>
      item && typeof item === 'object' ? mapper(item as Record<string, unknown>) : item,
    );
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      return {
        ...obj,
        items: obj.items.map(item =>
          item && typeof item === 'object' ? mapper(item as Record<string, unknown>) : item,
        ),
      };
    }
    return mapper(obj);
  }
  return value;
}

function createResponseHelpers(
  c: Context<AppEnv>,
  route: PlannedEntityRoute,
  config: ResolvedEntityConfig,
): EntityRouteExecutionContext['respond'] & { setOpResult(opName: string, result: unknown): void } {
  function applyTransform(data: unknown, status: number): unknown {
    // 1) Apply entity-level projection: strip private fields, run selected dto mapper.
    const responseSpec = route.responses?.[status];
    let value = applyEntityProjection(data, config, responseSpec?.dto);
    // 2) Apply user-supplied per-route transform if present for this status.
    if (responseSpec?.transform) value = responseSpec.transform(value);
    return value;
  }
  return {
    json(data: unknown, status = 200) {
      return c.json(
        applyTransform(data, status),
        status as import('hono/utils/http-status').ContentfulStatusCode,
      );
    },
    text(data: string, status = 200) {
      return c.text(data, status as import('hono/utils/http-status').ContentfulStatusCode);
    },
    html(data: string, status = 200) {
      return c.html(data, status as import('hono/utils/http-status').ContentfulStatusCode);
    },
    body(data: BodyInit | null | undefined, status = 200, headers?: HeadersInit) {
      return new Response(data ?? null, { status, headers });
    },
    notFound() {
      return c.json({ error: 'Not found' }, 404);
    },
    noContent() {
      return c.body(null, 204);
    },
    setOpResult(opName: string, result: unknown) {
      c.set('__routeKey' as never, route.routeKey as never);
      c.set('__opName' as never, opName as never);
      c.set('__opResult' as never, result as never);
    },
  };
}

function defaultGeneratedExecutor(
  route: PlannedEntityRoute,
  adapter: BareEntityAdapter,
): EntityRouteExecutor {
  if (route.generatedRouteKey === 'create') {
    return async exec => {
      const result = await adapter.create(exec.input);
      exec.setOpResult('create', result);
      return exec.respond.json(result, 201);
    };
  }

  if (route.generatedRouteKey === 'list') {
    return async exec => {
      const listInput = (exec.input ?? {}) as {
        cursor?: string;
        limit?: number;
        sortDir?: 'asc' | 'desc';
      };
      const result = await adapter.list({
        filter: exec.filter,
        limit: listInput.limit,
        cursor: listInput.cursor,
        sortDir: listInput.sortDir,
      });
      exec.setOpResult('list', result);
      return exec.respond.json(result);
    };
  }

  if (route.generatedRouteKey === 'get') {
    return async exec => {
      if (!exec.existingRecord) {
        return exec.respond.notFound();
      }
      exec.setOpResult('get', exec.existingRecord);
      return exec.respond.json(exec.existingRecord);
    };
  }

  if (route.generatedRouteKey === 'update') {
    return async exec => {
      const id = (exec.params as Record<string, string>).id;
      if (!id) {
        return exec.respond.notFound();
      }
      const result = await adapter.update(id, exec.input, exec.filter);
      if (!result) {
        return exec.respond.notFound();
      }
      exec.setOpResult('update', result);
      return exec.respond.json(result);
    };
  }

  if (route.generatedRouteKey === 'delete') {
    return async exec => {
      const id = (exec.params as Record<string, string>).id;
      if (!id) {
        return exec.respond.notFound();
      }
      const ok = await adapter.delete(id, exec.filter);
      if (!ok) {
        return exec.respond.notFound();
      }
      exec.setOpResult('delete', { id });
      return exec.respond.noContent();
    };
  }

  return async exec => {
    const opFn = adapter[route.opName];
    if (typeof opFn !== 'function' || !route.operationConfig) {
      return exec.respond.notFound();
    }
    const result = await invokeNamedOperation(
      route.operationConfig,
      opFn as OperationFunction,
      exec.input as Record<string, unknown>,
    );
    exec.setOpResult(route.opName, result);
    if (route.operationConfig.kind === 'lookup' && route.operationConfig.returns === 'one') {
      if (!result) {
        return exec.respond.notFound();
      }
      return exec.respond.json(result);
    }
    if (route.operationConfig.kind === 'exists') {
      return new Response(null, { status: result ? 200 : 404 });
    }
    return exec.respond.json(result);
  };
}

async function preparePlannedExecution(
  route: PlannedEntityRoute,
  c: Context<AppEnv>,
  adapter: BareEntityAdapter,
  schemas: ReturnType<typeof buildEntityZodSchemas>,
  dataScopes: ReturnType<typeof normalizeDataScopes>,
): Promise<PlannedExecutionPrep | Response> {
  const params = c.req.param() as Record<string, string>;
  const query = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const requestContext = buildRequestContext(c);

  if (route.kind === 'extra') {
    let rawBody: Record<string, unknown> | null = null;
    if (route.method !== 'get' && route.method !== 'head' && route.method !== 'delete') {
      try {
        rawBody = readJsonRecord((await c.req.json()) as unknown);
      } catch {
        // Body is optional for extra routes — treat unparseable input as absent
        rawBody = null;
      }
    }
    const parsedParams = parseTypedSection(c, route.request?.params, params);
    if (!parsedParams.success) return parsedParams.response;
    const parsedQuery = parseTypedSection(c, route.request?.query, query);
    if (!parsedQuery.success) return parsedQuery.response;
    const parsedBody = parseTypedSection(c, route.request?.body, rawBody ?? {});
    if (!parsedBody.success) return parsedBody.response;
    const body = route.request?.body !== undefined || rawBody !== null ? parsedBody.data : rawBody;
    return {
      params: parsedParams.data as Record<string, string>,
      query: asObjectRecord(parsedQuery.data),
      body,
      input: normalizeTypedInput(
        body,
        asObjectRecord(parsedQuery.data),
        parsedParams.data as Record<string, string>,
      ),
      requestContext,
    };
  }

  switch (route.generatedRouteKey) {
    case 'create': {
      const rawBody = readJsonRecord((await c.req.json()) as unknown);
      const parsedBody = parseTypedSection(c, route.request?.body, rawBody);
      if (!parsedBody.success) return parsedBody.response;
      const body = asObjectRecord(parsedBody.data);
      let dataScopeBindings: Record<string, unknown> | undefined;
      if (dataScopes.length > 0) {
        const resolution = resolveDataScopes(dataScopes, 'create', c);
        if (resolution.status === 'missing') {
          return c.json(
            { error: `dataScope source '${resolution.source}' not set on request context` },
            401,
          );
        }
        dataScopeBindings = resolution.bindings;
        Object.assign(body, resolution.bindings);
      }
      return {
        params,
        query,
        body,
        input: normalizeTypedInput(body, query, params),
        requestContext,
        dataScopeBindings,
      };
    }

    case 'list': {
      const querySchema = route.request?.query ?? schemas.listOptions;
      const parsedQuery = querySchema.safeParse(query);
      if (!parsedQuery.success) return validationErrorResponse(c, parsedQuery.error);

      const { limit, cursor, sortDir, ...validatedFilters } = parsedQuery.data as Record<
        string,
        unknown
      > & {
        limit?: number;
        cursor?: string;
        sortDir?: 'asc' | 'desc';
      };
      let filter = Object.keys(validatedFilters).length > 0 ? { ...validatedFilters } : undefined;
      let dataScopeBindings: Record<string, unknown> | undefined;
      if (dataScopes.length > 0) {
        const resolution = resolveDataScopes(dataScopes, 'list', c);
        if (resolution.status === 'missing') {
          return c.json(
            { error: `dataScope source '${resolution.source}' not set on request context` },
            401,
          );
        }
        dataScopeBindings = resolution.bindings;
        filter = { ...(filter ?? {}), ...resolution.bindings };
      }
      return {
        params,
        query,
        body: null,
        input: {
          ...validatedFilters,
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          ...(sortDir !== undefined ? { sortDir } : {}),
        },
        requestContext,
        filter,
        dataScopeBindings,
      };
    }

    case 'get':
    case 'update':
    case 'delete': {
      const rawParams = c.req.param() as Record<string, string>;
      const parsedParams = parseTypedSection(c, route.request?.params, rawParams);
      if (!parsedParams.success) return parsedParams.response;
      const parsedParamsRecord = asObjectRecord(parsedParams.data);
      const id =
        typeof parsedParamsRecord.id === 'string'
          ? parsedParamsRecord.id
          : readRequiredParam(c, 'id');
      let body: Record<string, unknown> | null = null;
      if (route.generatedRouteKey === 'update') {
        const rawBody = readJsonRecord((await c.req.json()) as unknown);
        const parsedBody = parseTypedSection(c, route.request?.body, rawBody);
        if (!parsedBody.success) return parsedBody.response;
        body = asObjectRecord(parsedBody.data);
        if (dataScopes.length > 0) {
          const offending = findScopedFieldInBody(dataScopes, body);
          if (offending !== null) {
            return c.json({ error: 'scoped_field_immutable', field: offending }, 400);
          }
        }
      }

      let filter: Record<string, unknown> | undefined;
      let dataScopeBindings: Record<string, unknown> | undefined;
      if (dataScopes.length > 0) {
        const resolution = resolveDataScopes(dataScopes, route.generatedRouteKey, c);
        if (resolution.status === 'missing') {
          return c.json(
            { error: `dataScope source '${resolution.source}' not set on request context` },
            401,
          );
        }
        filter = resolution.bindings;
        dataScopeBindings = resolution.bindings;
      }

      const existingRecord = await adapter.getById(id, filter);
      if (!existingRecord) {
        return c.json({ error: 'Not found' }, 404);
      }

      return {
        params: parsedParams.data as Record<string, string>,
        query,
        body,
        input:
          route.generatedRouteKey === 'update'
            ? normalizeTypedInput(body, query, parsedParamsRecord as Record<string, string>)
            : null,
        requestContext,
        filter,
        dataScopeBindings,
        existingRecord,
      };
    }

    default: {
      const input = await c.req
        .json()
        .then(value => value as unknown)
        .catch(() => ({}) as unknown);
      const rawBody = readJsonRecord(input);
      const pathParams = c.req.param() as Record<string, string>;
      const parsedParams = parseTypedSection(c, route.request?.params, pathParams);
      if (!parsedParams.success) return parsedParams.response;
      const parsedQuery = parseTypedSection(c, route.request?.query, query);
      if (!parsedQuery.success) return parsedQuery.response;
      const parsedBody = parseTypedSection(c, route.request?.body, rawBody);
      if (!parsedBody.success) return parsedBody.response;
      const parsedQueryRecord = asObjectRecord(parsedQuery.data);
      const parsedParamsRecord = parsedParams.data as Record<string, string>;
      const body =
        route.request?.body !== undefined || Object.keys(rawBody).length > 0
          ? parsedBody.data
          : null;
      const actor = getActor(c);
      const ctxOverrides: Record<string, unknown> = {};
      if (actor.id != null) {
        ctxOverrides['actor.id'] = actor.id;
      }
      if (actor.tenantId != null) {
        ctxOverrides['actor.tenantId'] = actor.tenantId;
      }
      ctxOverrides['actor.kind'] = actor.kind;
      if (actor.sessionId != null) {
        ctxOverrides['actor.sessionId'] = actor.sessionId;
      }
      const mergedInput = {
        ...parsedQueryRecord,
        ...asObjectRecord(body),
        ...parsedParamsRecord,
        ...ctxOverrides,
      };
      return {
        params: parsedParamsRecord,
        query: parsedQueryRecord,
        body,
        input: Object.keys(mergedInput).length > 0 ? mergedInput : null,
        requestContext,
      };
    }
  }
}

async function applyPostFetchPolicyForPlannedRoute(
  route: PlannedEntityRoute,
  c: Context<AppEnv>,
  options: {
    policyConfig?: EntityRoutePolicyConfig;
    policyResolver?: PolicyResolver;
    bus?: SlingshotEventBus;
  },
  prep: PlannedExecutionPrep,
): Promise<Response | null> {
  if (
    !options.policyConfig ||
    !options.policyResolver ||
    !prep.existingRecord ||
    (route.generatedRouteKey !== 'get' &&
      route.generatedRouteKey !== 'update' &&
      route.generatedRouteKey !== 'delete')
  ) {
    return null;
  }

  if (!policyAppliesToOp(options.policyConfig, route.opName)) {
    return null;
  }

  await resolvePolicy({
    c,
    config: options.policyConfig,
    resolver: options.policyResolver,
    action:
      route.generatedRouteKey === 'get'
        ? { kind: 'get' }
        : route.generatedRouteKey === 'update'
          ? { kind: 'update' }
          : { kind: 'delete' },
    record: prep.existingRecord,
    input: prep.body,
    bus: options.bus,
  });
  return null;
}

function createPlannedRouteDefinition(
  route: PlannedEntityRoute,
  config: ResolvedEntityConfig,
  schemas: ReturnType<typeof buildEntityZodSchemas>,
  tag: string,
): RouteDefinition {
  const errorSchema = z.object({ error: z.string() });

  if (route.kind === 'extra') {
    const request = buildTypedRouteRequest(route.request);
    return createRoute({
      method: route.method,
      path: route.path,
      tags: [tag],
      summary: route.summary ?? route.opName,
      ...(route.description ? { description: route.description } : {}),
      ...(request ? { request } : {}),
      responses: buildTypedRouteResponses(route.responses, {
        200: {
          content: { 'application/json': { schema: z.unknown() } },
          description: 'OK',
        },
      }),
    });
  }

  switch (route.generatedRouteKey) {
    case 'create': {
      const request = buildTypedRouteRequest(route.request) ?? {
        body: { content: { 'application/json': { schema: schemas.create } } },
      };
      return createRoute({
        method: 'post',
        path: route.path,
        tags: [tag],
        summary: route.summary ?? `Create ${config.name}`,
        ...(route.description ? { description: route.description } : {}),
        request,
        responses: buildTypedRouteResponses(route.responses, {
          201: {
            content: { 'application/json': { schema: schemas.entity } },
            description: 'Created',
          },
        }),
      });
    }
    case 'list': {
      const request = buildTypedRouteRequest(route.request) ?? { query: schemas.listOptions };
      return createRoute({
        method: 'get',
        path: route.path,
        tags: [tag],
        summary: route.summary ?? `List ${config.name}`,
        ...(route.description ? { description: route.description } : {}),
        request,
        responses: buildTypedRouteResponses(route.responses, {
          200: { content: { 'application/json': { schema: schemas.list } }, description: 'OK' },
        }),
      });
    }
    case 'get': {
      const request =
        buildTypedRouteRequest(route.request) ??
        ({
          params: z.object({ id: z.string() }),
        } satisfies NonNullable<Parameters<typeof createRoute>[0]['request']>);
      return createRoute({
        method: 'get',
        path: route.path,
        tags: [tag],
        summary: route.summary ?? `Get ${config.name} by ID`,
        ...(route.description ? { description: route.description } : {}),
        request,
        responses: buildTypedRouteResponses(route.responses, {
          200: { content: { 'application/json': { schema: schemas.entity } }, description: 'OK' },
          404: {
            content: { 'application/json': { schema: errorSchema } },
            description: 'Not found',
          },
        }),
      });
    }
    case 'update': {
      const request = buildTypedRouteRequest(route.request) ?? {
        params: z.object({ id: z.string() }),
        body: { content: { 'application/json': { schema: schemas.update } } },
      };
      return createRoute({
        method: 'patch',
        path: route.path,
        tags: [tag],
        summary: route.summary ?? `Update ${config.name}`,
        ...(route.description ? { description: route.description } : {}),
        request,
        responses: buildTypedRouteResponses(route.responses, {
          200: { content: { 'application/json': { schema: schemas.entity } }, description: 'OK' },
          404: {
            content: { 'application/json': { schema: errorSchema } },
            description: 'Not found',
          },
        }),
      });
    }
    case 'delete': {
      const request =
        buildTypedRouteRequest(route.request) ??
        ({
          params: z.object({ id: z.string() }),
        } satisfies NonNullable<Parameters<typeof createRoute>[0]['request']>);
      return createRoute({
        method: 'delete',
        path: route.path,
        tags: [tag],
        summary: route.summary ?? `Delete ${config.name}`,
        ...(route.description ? { description: route.description } : {}),
        request,
        responses: buildTypedRouteResponses(route.responses, { 204: { description: 'Deleted' } }),
      });
    }
    default: {
      const operationConfig = route.operationConfig;
      const routeParams =
        operationConfig?.kind === 'lookup' || operationConfig?.kind === 'exists'
          ? [...new Set(route.path.match(/:([A-Za-z]\w*)/g)?.map(param => param.slice(1)) ?? [])]
          : [];
      const defaultRequest =
        routeParams.length > 0
          ? ({
              params: z.object(Object.fromEntries(routeParams.map(param => [param, z.string()]))),
            } satisfies NonNullable<Parameters<typeof createRoute>[0]['request']>)
          : undefined;
      const request = buildTypedRouteRequest(route.request) ?? defaultRequest;
      const responses: Parameters<typeof createRoute>[0]['responses'] =
        operationConfig?.kind === 'lookup'
          ? operationConfig.returns === 'one'
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
          : operationConfig?.kind === 'exists'
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

      return createRoute({
        method: route.method,
        path: route.path,
        tags: [tag],
        summary: route.summary ?? route.opName,
        ...(route.description ? { description: route.description } : {}),
        ...(request ? { request } : {}),
        responses: buildTypedRouteResponses(route.responses, responses),
      });
    }
  }
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
 * - `actor.id` / `actor.tenantId` / `actor.kind` / `actor.sessionId` — projected from the canonical request actor
 *
 * This allows transaction step bindings like `'param:actor.id'`, `'param:actor.tenantId'`,
 * `'param:actor.sessionId'`, and `'param:id'` to resolve from server-side
 * context or URL params rather than requiring the client to supply them in the request body.
 * Context values always win — clients cannot override them.
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
  } & PlannedRouteOptions,
): RouterT | OpenAPIHono<AppEnv> {
  const router = existingRouter ?? new OpenAPIHono<AppEnv>();
  const entitySegment = options?.routePath ?? entityToPath(config.name);
  const segment = options?.parentPath
    ? `${options.parentPath.replace(/^\//, '')}/${entitySegment}`
    : entitySegment;
  const schemas = buildEntityZodSchemas(config);
  // Cache per-variant schema builds — each (entity, variant) combo is built at most
  // once per call to buildBareEntityRoutes. The default-variant build is reused via
  // `schemas` above; named variants are produced lazily when a route asks for them.
  const variantSchemaCache = new Map<string, ReturnType<typeof buildEntityZodSchemas>>();
  function schemasForVariant(variant: string | undefined): ReturnType<typeof buildEntityZodSchemas> {
    if (!variant) return schemas;
    const cached = variantSchemaCache.get(variant);
    if (cached) return cached;
    const built = buildEntityZodSchemas(config, variant);
    variantSchemaCache.set(variant, built);
    return built;
  }
  const disabled = new Set(config.routes?.disable ?? []);
  const tag = options?.tag ?? config.name;
  const dataScopes = normalizeDataScopes(options?.dataScope ?? config.routes?.dataScope);
  const policyConfig = options?.policyConfig;
  const policyResolver = options?.policyResolver;
  const policyBus = options?.bus;
  const errorSchema = z.object({ error: z.string() });
  const plannedRoutes = options?.plannedRoutes;

  if (plannedRoutes && plannedRoutes.length > 0) {
    const getEntityAdapter =
      options.getEntityAdapter ??
      (() => {
        throw new Error(
          `Cross-entity adapter lookup is unavailable for planned routes on '${config.name}'`,
        );
      });

    for (const route of plannedRoutes) {
      const executorBuilderContext: EntityRouteExecutorBuilderContext = {
        entity: config,
        routeKey: route.routeKey,
        generatedRouteKey: route.generatedRouteKey,
        entityAdapter: adapter,
        getEntityAdapter,
      };
      const executor =
        route.buildExecutor?.(executorBuilderContext) ?? defaultGeneratedExecutor(route, adapter);
      const routeDef = createPlannedRouteDefinition(route, config, schemas, tag);

      registerRoute(router, routeDef, async c => {
        c.set('__routeKey' as never, route.routeKey as never);
        const prep = await preparePlannedExecution(route, c, adapter, schemas, dataScopes);
        if (prep instanceof Response) {
          return prep;
        }

        const policyResponse = await applyPostFetchPolicyForPlannedRoute(
          route,
          c,
          {
            policyConfig,
            policyResolver,
            bus: policyBus,
          },
          prep,
        );
        if (policyResponse) {
          return policyResponse;
        }

        const helpers = createResponseHelpers(c, route, config);
        const execContext: EntityRouteExecutionContext = {
          request: c,
          actor: getActor(c),
          entity: config,
          routeKey: route.routeKey,
          generatedRouteKey: route.generatedRouteKey,
          entityAdapter: adapter,
          params: prep.params,
          query: prep.query,
          body: prep.body,
          input: prep.input,
          requestContext: prep.requestContext,
          filter: prep.filter,
          dataScopeBindings: prep.dataScopeBindings,
          existingRecord: prep.existingRecord,
          getEntityAdapter,
          respond: helpers,
          setOpResult: helpers.setOpResult,
        };

        return executor(execContext);
      });
    }

    return router;
  }

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
    const responses: Parameters<typeof createRoute>[0]['responses'] =
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
      // Inject actor-derived context values so transaction param bindings (e.g.
      // 'param:actor.id', 'param:actor.tenantId') resolve from request identity
      // without requiring the client to supply them in the body.
      // Merge priority: body < path params < context overrides.
      // Context values always win — clients cannot spoof them.
      const bodyRecord =
        typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
      // Path params (e.g. :id from op.custom http.path) come after body so URL-encoded
      // values take precedence over body fields of the same name.
      const pathParams = c.req.param() as Record<string, string>;
      const queryParams = Object.fromEntries(new URL(c.req.url).searchParams.entries());
      // Context values override both body and path params — clients cannot spoof them.
      const actor = getActor(c);
      const ctxOverrides: Record<string, unknown> = {};
      if (actor.id != null) {
        ctxOverrides['actor.id'] = actor.id;
      }
      if (actor.tenantId != null) {
        ctxOverrides['actor.tenantId'] = actor.tenantId;
      }
      ctxOverrides['actor.kind'] = actor.kind;
      if (actor.sessionId != null) {
        ctxOverrides['actor.sessionId'] = actor.sessionId;
      }
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
        return c.json(applyEntityProjection(result, config), 200);
      }
      if (opConfig.kind === 'exists') {
        return result ? c.body(null, 200) : c.body(null, 404);
      }
      return c.json(applyEntityProjection(result, config), 200);
    });
  }

  // POST /{segment} — create
  if (!routeDisabled(disabled, 'create', 'POST', `/${segment}`)) {
    const createSchemas = schemasForVariant(config.routes?.create?.input);
    registerRoute(
      router,
      createRoute({
        method: 'post',
        path: `/${segment}`,
        tags: [tag],
        summary: `Create ${config.name}`,
        request: { body: { content: { 'application/json': { schema: createSchemas.create } } } },
        responses: {
          201: {
            content: { 'application/json': { schema: schemas.entity } },
            description: 'Created',
          },
        },
      }),
      async c => {
        const raw = (await c.req.json()) as unknown;
        // Parse against the variant-filtered create schema so fields not allowed
        // by `routes.create.input` (e.g. `role` on the public variant) are
        // silently stripped before reaching the adapter — making the variant
        // gate a real security boundary, not just OpenAPI documentation.
        const parsed = (createSchemas.create as z.ZodTypeAny).safeParse(raw);
        if (!parsed.success) {
          return c.json(
            {
              success: false,
              error: { name: 'ZodError', message: parsed.error.message },
            },
            400,
          ) as never;
        }
        const bodyRecord = { ...(parsed.data as Record<string, unknown>) };

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
        return c.json(applyEntityProjection(result, config, config.routes?.create?.dto), 201);
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
        return c.json(applyEntityProjection(result, config, config.routes?.list?.dto), 200);
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
        return c.json(applyEntityProjection(result, config, config.routes?.get?.dto), 200);
      },
    );
  }

  // PATCH /{segment}/:id — update (using PATCH to match generated routes.ts)
  if (!routeDisabled(disabled, 'update', 'PATCH', `/${segment}/:id`)) {
    const updateSchemas = schemasForVariant(config.routes?.update?.input);
    registerRoute(
      router,
      createRoute({
        method: 'patch',
        path: `/${segment}/:id`,
        tags: [tag],
        summary: `Update ${config.name}`,
        request: { body: { content: { 'application/json': { schema: updateSchemas.update } } } },
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
        const raw = (await c.req.json()) as unknown;
        // Parse against the variant-filtered update schema so fields not allowed
        // by `routes.update.input` are silently stripped before reaching the adapter.
        const parsed = (updateSchemas.update as z.ZodTypeAny).safeParse(raw);
        if (!parsed.success) {
          return c.json(
            {
              success: false,
              error: { name: 'ZodError', message: parsed.error.message },
            },
            400,
          ) as never;
        }
        const bodyRecord = { ...(parsed.data as Record<string, unknown>) };

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
        return c.json(applyEntityProjection(result, config, config.routes?.update?.dto), 200);
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
