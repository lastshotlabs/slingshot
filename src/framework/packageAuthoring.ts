import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  type AppEnv,
  HEADER_IDEMPOTENCY_KEY,
  type PackageCapabilityHandle,
  type PackageDomainRouteContext,
  type PackageEntityRef,
  RESOLVE_ENTITY_FACTORIES,
  type SlingshotPackageDefinition,
  type SlingshotPackageEntityModuleLike,
  type SlingshotPlugin,
  type TypedRouteRequestSpec,
  type TypedRouteResponseSpec,
  type TypedRouteResponses,
  createRoute,
  createRouter,
  defineEvent,
  getActor,
  getContextOrNull,
  getPermissionsStateOrNull,
  getSlingshotCtx,
  hmacSign,
  inspectPackage,
  requireEntityAdapter,
  resolveRepo,
  sha256,
} from '@lastshotlabs/slingshot-core';
import type {
  OperationConfig,
  RepoFactories,
  ResolvedEntityConfig,
  RouteEventConfig,
  RouteIdempotencyConfig,
  RouteOperationConfig,
} from '@lastshotlabs/slingshot-core';
import {
  type BareEntityAdapter,
  type EntityPluginEntry,
  type PackageEntityModule,
  buildPolicyAction,
  createEntityPlugin,
  evaluateRouteAuth,
  freezeEntityPolicyRegistry,
  getEntityPolicyResolver,
  resolvePolicy,
  safeReadJsonBody,
} from '@lastshotlabs/slingshot-entity';
import { rateLimit } from './middleware/rateLimit';

const PACKAGE_CAPABILITIES_PREFIX = 'slingshot:package:capabilities:';
const PACKAGE_INSPECTION_PREFIX = 'slingshot:package:inspection:';

type OpenApiRouteDefinition = ReturnType<typeof createRoute>;
type OpenApiRegistrar = OpenAPIHono<AppEnv> & {
  openapi(
    route: OpenApiRouteDefinition,
    handler: (c: import('hono').Context<AppEnv>) => unknown,
  ): unknown;
};

type CompiledPackages = {
  plugins: SlingshotPlugin[];
};

type CapabilityProviderMap = ReadonlyMap<string, string>;

type EntityFactoryCreator = (
  config: ResolvedEntityConfig,
  operations?: Record<string, OperationConfig>,
) => RepoFactories<Record<string, unknown>>;

function normalizePath(base: string | undefined, child: string | undefined): string {
  const left = base ? `/${base.replace(/^\/+|\/+$/g, '')}` : '';
  const right = child ? `/${child.replace(/^\/+|\/+$/g, '')}` : '';
  const combined = `${left}${right}`.replace(/\/+/g, '/');
  return combined === '' ? '/' : combined;
}

function methodGuard(
  method: string,
  handler: MiddlewareHandler<AppEnv>,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method !== method.toUpperCase()) {
      await next();
      return;
    }
    return handler(c, next);
  };
}

function validationErrorResponse(
  c: import('hono').Context<AppEnv>,
  error: import('zod').ZodError,
): Response {
  return c.json(
    {
      success: false,
      error: { name: 'ZodError', message: error.message },
    },
    400,
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

function parseTypedSection(
  c: import('hono').Context<AppEnv>,
  schema: import('zod').ZodTypeAny | undefined,
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

function normalizeRouteInput(
  params: Record<string, string>,
  query: Record<string, unknown>,
  body: unknown,
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
  const merged = {
    ...query,
    ...params,
    ...asObjectRecord(body),
  };
  return Object.keys(merged).length > 0 ? merged : null;
}

function asObjectRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function buildTypedRouteRequest(
  request: TypedRouteRequestSpec | undefined,
): Parameters<typeof createRoute>[0]['request'] | undefined {
  if (!request) return undefined;
  const built: NonNullable<Parameters<typeof createRoute>[0]['request']> = {};
  if (request.params) built.params = request.params as never;
  if (request.query) built.query = request.query as never;
  if (request.body) {
    built.body = { content: { 'application/json': { schema: request.body } } };
  }
  return Object.keys(built).length > 0 ? built : undefined;
}

function buildTypedResponse(response: TypedRouteResponseSpec): {
  description: string;
  content?: Record<string, { schema: import('zod').ZodTypeAny }>;
} {
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

function buildTypedRouteResponses(
  responses: TypedRouteResponses | undefined,
): Parameters<typeof createRoute>[0]['responses'] {
  if (!responses || Object.keys(responses).length === 0) {
    return {
      200: {
        description: 'OK',
      },
    };
  }
  return Object.fromEntries(
    Object.entries(responses).map(([status, response]) => [status, buildTypedResponse(response)]),
  ) as Parameters<typeof createRoute>[0]['responses'];
}

function registerRoute(
  router: OpenApiRegistrar,
  route: OpenApiRouteDefinition,
  handler: (c: import('hono').Context<AppEnv>) => Response | Promise<Response>,
): void {
  if (route.method === 'head') {
    const headOnly = async (c: import('hono').Context<AppEnv>) => {
      if (c.req.method !== 'HEAD') {
        return c.body(null, 404);
      }
      return handler(c);
    };
    router.openapi(route, headOnly);
    router.get(route.path, headOnly);
    return;
  }
  router.openapi(route, handler);
}

function createDomainRespond(c: import('hono').Context<AppEnv>, routeKey: string) {
  return {
    json(data: unknown, status = 200) {
      c.set('__packageRouteKey' as never, routeKey as never);
      if (typeof data === 'object' && data !== null) {
        c.set('__opResult' as never, data as never);
      }
      return c.json(data, status as import('hono/utils/http-status').ContentfulStatusCode);
    },
    text(data: string, status = 200) {
      c.set('__packageRouteKey' as never, routeKey as never);
      return c.text(data, status as import('hono/utils/http-status').ContentfulStatusCode);
    },
    html(data: string, status = 200) {
      c.set('__packageRouteKey' as never, routeKey as never);
      return c.html(data, status as import('hono/utils/http-status').ContentfulStatusCode);
    },
    body(data: BodyInit | null | undefined, status = 200, headers?: HeadersInit) {
      c.set('__packageRouteKey' as never, routeKey as never);
      return new Response(data ?? null, { status, headers });
    },
    noContent() {
      c.set('__packageRouteKey' as never, routeKey as never);
      return c.body(null, 204);
    },
    notFound(message = 'Not found') {
      c.set('__packageRouteKey' as never, routeKey as never);
      return c.json({ error: message }, 404);
    },
  };
}

function resolvePackageCapabilities(app: object, capabilityProviders: CapabilityProviderMap) {
  return {
    maybe<TValue>(capability: PackageCapabilityHandle<TValue>): TValue | undefined {
      const providerName = capabilityProviders.get(capability.name);
      if (!providerName) return undefined;
      const state = getContextOrNull(app)?.pluginState.get(
        `${PACKAGE_CAPABILITIES_PREFIX}${providerName}`,
      ) as Record<string, unknown> | undefined;
      return state?.[capability.name] as TValue | undefined;
    },
    require<TValue>(capability: PackageCapabilityHandle<TValue>): TValue {
      const value = this.maybe(capability);
      if (value === undefined) {
        throw new Error(`Required package capability '${capability.name}' is not available`);
      }
      return value;
    },
  };
}

function isPackageEntityModuleLike(
  value: unknown,
): value is SlingshotPackageEntityModuleLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind?: unknown }).kind === 'entity' &&
    'entityName' in value &&
    typeof (value as { entityName?: unknown }).entityName === 'string'
  );
}

function isPackageEntityRef(value: unknown): value is PackageEntityRef<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind?: unknown }).kind === 'entity-ref' &&
    'entity' in value &&
    typeof (value as { entity?: unknown }).entity === 'string'
  );
}

function buildPackageEntityReader(app: object, packageName: string) {
  return {
    get<TValue = unknown>(
      target:
        | SlingshotPackageEntityModuleLike<TValue>
        | PackageEntityRef<TValue>
        | { entity: string; plugin?: string },
    ): TValue {
      if (isPackageEntityModuleLike(target)) {
        return requireEntityAdapter(app, {
          plugin: packageName,
          entity: target.entityName,
        }) as TValue;
      }
      if (isPackageEntityRef(target)) {
        return requireEntityAdapter(app, {
          plugin: target.plugin ?? packageName,
          entity: target.entity,
        }) as TValue;
      }
      return requireEntityAdapter(app, {
        plugin: target.plugin ?? packageName,
        entity: target.entity,
      }) as TValue;
    },
  };
}

function resolvePermissions(app: object) {
  const state = getPermissionsStateOrNull(app);
  if (!state) return undefined;
  return {
    evaluator: state.evaluator,
    registry: state.registry,
    adapter: state.adapter,
  };
}

function normalizeRouteEventConfig(
  event: RouteEventConfig | string | undefined,
): RouteEventConfig | undefined {
  if (!event) return undefined;
  return typeof event === 'string' ? { key: event, exposure: ['internal'] } : event;
}

function resolvePublishContextValue(
  publishContext: Record<string, unknown>,
  path: string,
): unknown {
  let current: unknown = publishContext;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = Reflect.get(current, segment);
  }
  return current;
}

function resolveEventScopeValue(
  value: string | undefined,
  payload: Record<string, unknown>,
  publishContext: Record<string, unknown>,
): string | null | undefined {
  if (!value) return undefined;
  if (value.startsWith('record:')) {
    const resolved = payload[value.slice('record:'.length)];
    return typeof resolved === 'string' ? resolved : resolved === null ? null : undefined;
  }
  if (value.startsWith('ctx:')) {
    const resolved = resolvePublishContextValue(publishContext, value.slice('ctx:'.length));
    return typeof resolved === 'string' ? resolved : resolved === null ? null : undefined;
  }
  return undefined;
}

function buildRouteEventScope(
  event: RouteEventConfig,
  payload: Record<string, unknown>,
  publishContext: Record<string, unknown>,
) {
  if (!event.scope) {
    return null;
  }

  const scope = {
    tenantId: resolveEventScopeValue(event.scope.tenantId, payload, publishContext),
    userId: resolveEventScopeValue(event.scope.userId, payload, publishContext),
    appId: resolveEventScopeValue(event.scope.appId, payload, publishContext),
    actorId: resolveEventScopeValue(event.scope.actorId, payload, publishContext),
    resourceType: event.scope.resourceType,
    resourceId:
      resolveEventScopeValue(event.scope.resourceId, payload, publishContext) ?? undefined,
  };

  if (
    scope.tenantId === undefined &&
    scope.userId === undefined &&
    scope.appId === undefined &&
    scope.actorId === undefined &&
    scope.resourceType === undefined &&
    scope.resourceId === undefined
  ) {
    return null;
  }

  return scope;
}

function registerPackageRouteEvents(
  events: import('@lastshotlabs/slingshot-core').SlingshotEvents,
  pkg: SlingshotPackageDefinition,
): void {
  for (const domain of pkg.domains) {
    for (const routeDefinition of domain.routes) {
      const event = normalizeRouteEventConfig(routeDefinition.event);
      if (!event) continue;
      events.register(
        defineEvent(event.key as keyof import('@lastshotlabs/slingshot-core').SlingshotEventMap, {
          ownerPlugin: pkg.name,
          exposure: Object.freeze([...(event.exposure ?? ['internal'])]),
          resolveScope(payload, publishContext) {
            return buildRouteEventScope(
              event,
              payload as Record<string, unknown>,
              publishContext as Record<string, unknown>,
            );
          },
        }),
      );
    }
  }
}

function resolvePackageEntityRef(
  app: object,
  packageName: string,
  ref: PackageEntityRef | undefined,
): BareEntityAdapter | undefined {
  if (!ref) return undefined;
  return requireEntityAdapter(app, {
    plugin: ref.plugin ?? packageName,
    entity: ref.entity,
  }) as BareEntityAdapter;
}

function collectPackagePolicyResolvers(
  app: import('hono').Hono<AppEnv>,
  pkg: SlingshotPackageDefinition,
): ReadonlyMap<string, import('@lastshotlabs/slingshot-core').PolicyResolver> {
  const keys = new Set<string>();
  for (const domain of pkg.domains) {
    for (const routeDefinition of domain.routes) {
      if (routeDefinition.permission?.policy) {
        keys.add(routeDefinition.permission.policy.resolver);
      }
    }
  }
  if (keys.size === 0) return new Map();

  const resolved = new Map<string, import('@lastshotlabs/slingshot-core').PolicyResolver>();
  for (const key of keys) {
    const resolver = getEntityPolicyResolver(app, key);
    if (!resolver) {
      throw new Error(
        `[Package:${pkg.name}] Domain route policy resolver '${key}' was not registered via registerEntityPolicy() before setupRoutes`,
      );
    }
    resolved.set(key, resolver);
  }
  return resolved;
}

async function publishPackageRuntimeState(
  app: object,
  pkg: SlingshotPackageDefinition,
): Promise<void> {
  const appContext = getContextOrNull(app);
  if (!appContext) return;

  const capabilityEntries = await Promise.all(
    pkg.capabilities.provides.map(async provider => [
      provider.capability.name,
      await provider.resolve({ packageName: pkg.name }),
    ]),
  );

  appContext.pluginState.set(
    `${PACKAGE_CAPABILITIES_PREFIX}${pkg.name}`,
    Object.freeze(Object.fromEntries(capabilityEntries)),
  );
  appContext.pluginState.set(
    `${PACKAGE_INSPECTION_PREFIX}${pkg.name}`,
    Object.freeze(inspectPackage(pkg)),
  );
}

function normalizeIdempotencyConfig(
  config: boolean | RouteIdempotencyConfig | undefined,
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

async function buildRequestFingerprint(c: import('hono').Context<AppEnv>): Promise<string> {
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
  routeKey: string,
  c: import('hono').Context<AppEnv>,
  config: Required<RouteIdempotencyConfig>,
): string {
  const slingshotCtx = getSlingshotCtx(c);
  const signingConfig = slingshotCtx.signing;
  const signingSecret = signingConfig?.secret ?? null;
  const keyToken =
    signingConfig?.idempotencyKeys && signingSecret ? hmacSign(rawKey, signingSecret) : rawKey;
  const actor = getActor(c);

  const parts = ['package-idempotency', routeKey];
  switch (config.scope) {
    case 'global':
      parts.push('global');
      break;
    case 'tenant':
      parts.push(`tenant:${actor.tenantId ?? 'none'}`);
      break;
    case 'user':
      if (!actor.id) {
        throw new Error(
          `Package route idempotency for '${routeKey}' requires actor.id when scope is 'user'`,
        );
      }
      if (actor.tenantId) parts.push(`tenant:${actor.tenantId}`);
      parts.push(`user:${actor.id}`);
      break;
  }
  parts.push(keyToken);
  return parts.join(':');
}

function idempotencyConflictResponse(c: import('hono').Context<AppEnv>): Response {
  return c.json(
    {
      error: 'Idempotency-Key reuse with different request',
      code: 'idempotency_key_conflict',
    },
    409,
  );
}

function createPackageRouteIdempotencyMiddleware(
  routeKey: string,
  config: Required<RouteIdempotencyConfig>,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const rawKey = c.req.header(HEADER_IDEMPOTENCY_KEY);
    if (!rawKey) {
      await next();
      return;
    }

    const adapter = getSlingshotCtx(c).persistence.idempotency;
    const requestFingerprint = await buildRequestFingerprint(c);
    const derivedKey = buildScopedIdempotencyKey(rawKey, routeKey, c, config);

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

function emitRouteEvent(
  c: import('hono').Context<AppEnv>,
  event: RouteEventConfig | undefined,
): void {
  if (!event) return;
  const events = getSlingshotCtx(c).events;
  const result = c.get('__opResult' as never) as Record<string, unknown> | undefined;
  if (!events || !result) return;

  const normalized: RouteEventConfig =
    typeof event === 'string' ? { key: event, exposure: ['internal'] } : event;
  const payload: Record<string, unknown> = {};
  if (normalized.payload?.length) {
    for (const key of normalized.payload) {
      payload[key] = result[key];
    }
  } else {
    Object.assign(payload, result);
  }
  const actor = getActor(c);
  for (const includeField of normalized.include ?? []) {
    switch (includeField) {
      case 'tenantId':
        payload.tenantId = actor.tenantId;
        break;
      case 'actorId':
        payload.actorId = actor.id;
        break;
      case 'requestId':
        payload.requestId = c.get('requestId' as never);
        break;
      case 'ip':
        payload.ip = c.req.header('x-forwarded-for') ?? null;
        break;
    }
  }
  const actorId = actor.kind === 'anonymous' ? undefined : actor.id;
  events.publish(normalized.key as never, payload as never, {
    tenantId: actor.tenantId ?? null,
    userId: actor.kind === 'user' ? actor.id : undefined,
    actorId,
    requestId: c.get('requestId' as never) as string | undefined,
    correlationId: c.get('requestId' as never) as string | undefined,
    source: 'http',
  });
}

function compileEntityEntry(module: PackageEntityModule): EntityPluginEntry {
  const impl = module.implementation;
  if (impl.wiring.mode === 'manual') {
    return {
      config: impl.config,
      authoringSource: 'package',
      operations: impl.operations,
      extraRoutes: impl.extraRoutes,
      overrides: impl.overrides,
      channels: impl.channels,
      routePath: impl.routePath,
      parentPath: impl.parentPath,
      buildAdapter: impl.wiring.buildAdapter,
    };
  }

  if (impl.wiring.mode === 'factories') {
    return {
      config: impl.config,
      authoringSource: 'package',
      operations: impl.operations,
      extraRoutes: impl.extraRoutes,
      overrides: impl.overrides,
      channels: impl.channels,
      routePath: impl.routePath,
      parentPath: impl.parentPath,
      factories: impl.wiring.factories,
      entityKey: impl.wiring.entityKey,
      onAdapter: impl.wiring.onAdapter,
    };
  }

  return {
    config: impl.config,
    authoringSource: 'package',
    operations: impl.operations,
    extraRoutes: impl.extraRoutes,
    overrides: impl.overrides,
    channels: impl.channels,
    routePath: impl.routePath,
    parentPath: impl.parentPath,
    buildAdapter(storeType, infra) {
      const creator = Reflect.get(infra as object, RESOLVE_ENTITY_FACTORIES) as
        | EntityFactoryCreator
        | undefined;
      if (!creator) {
        throw new Error(
          `[Package:${module.name}] Standard entity wiring requires RESOLVE_ENTITY_FACTORIES to be available on storeInfra`,
        );
      }
      const factories = creator(impl.config, impl.operations);
      return resolveRepo(factories, storeType, infra) as unknown as BareEntityAdapter;
    },
  };
}

function createPackagePlugin(
  pkg: SlingshotPackageDefinition,
  capabilityProviders: CapabilityProviderMap,
): SlingshotPlugin {
  const entityModules = pkg.entities as PackageEntityModule[];
  const entityPlugin =
    entityModules.length > 0
      ? createEntityPlugin({
          name: pkg.name,
          mountPath: pkg.mountPath,
          entities: entityModules.map(compileEntityEntry),
          middleware: pkg.middleware ? { ...pkg.middleware } : undefined,
          rateLimitFactory: opts => rateLimit(opts),
        })
      : null;

  const capabilityReaderFactory = (app: object) =>
    resolvePackageCapabilities(app, capabilityProviders);

  return {
    name: pkg.name,
    dependencies: [
      ...(pkg.dependencies ?? []),
      ...pkg.capabilities.requires
        .map(capability => capabilityProviders.get(capability.name))
        .filter((name): name is string => Boolean(name && name !== pkg.name)),
    ],
    tenantExemptPaths: pkg.tenantExemptPaths ? [...pkg.tenantExemptPaths] : undefined,
    csrfExemptPaths: pkg.csrfExemptPaths ? [...pkg.csrfExemptPaths] : undefined,
    publicPaths: pkg.publicPaths ? [...pkg.publicPaths] : undefined,

    async setupMiddleware(ctx) {
      await entityPlugin?.setupMiddleware?.(ctx);
      await publishPackageRuntimeState(ctx.app, pkg);
      registerPackageRouteEvents(ctx.events, pkg);
    },

    async setupRoutes(ctx) {
      await entityPlugin?.setupRoutes?.(ctx);
      if (pkg.domains.length === 0) {
        return;
      }

      const router = createRouter() as OpenApiRegistrar;
      const permissions = resolvePermissions(ctx.app);
      const policyResolvers = collectPackagePolicyResolvers(ctx.app, pkg);

      for (const domain of pkg.domains) {
        const services = domain.services ?? {};
        for (const routeDefinition of domain.routes) {
          const routePath = normalizePath(
            normalizePath(pkg.mountPath, domain.basePath),
            routeDefinition.path,
          );
          const routeKey = `${pkg.name}:${domain.name}:${routeDefinition.method}:${routePath}`;
          const opConfig = {
            auth: routeDefinition.auth,
            permission: routeDefinition.permission,
            rateLimit: routeDefinition.rateLimit,
            idempotency: routeDefinition.idempotency,
            middleware: routeDefinition.middleware ? [...routeDefinition.middleware] : undefined,
            event: routeDefinition.event,
          } satisfies RouteOperationConfig;
          const permissionAdapter = resolvePackageEntityRef(
            ctx.app,
            pkg.name,
            routeDefinition.permissionAdapter,
          );
          const parentAdapter = resolvePackageEntityRef(
            ctx.app,
            pkg.name,
            routeDefinition.parentAdapter,
          );
          const policyConfig = routeDefinition.permission?.policy;
          const policyResolver = policyConfig
            ? policyResolvers.get(policyConfig.resolver)
            : undefined;

          if (routeDefinition.rateLimit) {
            router.use(
              routePath,
              methodGuard(routeDefinition.method, rateLimit(routeDefinition.rateLimit)),
            );
          }

          const idempotency = normalizeIdempotencyConfig(routeDefinition.idempotency);
          if (idempotency) {
            router.use(
              routePath,
              methodGuard(
                routeDefinition.method,
                createPackageRouteIdempotencyMiddleware(routeKey, idempotency),
              ),
            );
          }

          if (routeDefinition.auth || routeDefinition.permission || policyConfig) {
            router.use(
              routePath,
              methodGuard(routeDefinition.method, async (c, next) => {
                const authResult = await evaluateRouteAuth(c, opConfig, {
                  routeAuth: getSlingshotCtx(c).routeAuth,
                  permissionEvaluator: permissions?.evaluator,
                  adapter: permissionAdapter,
                  parentAdapter,
                });
                if (!authResult.authorized) {
                  return authResult.response ?? c.json({ error: 'Forbidden' }, 403);
                }

                if (routeDefinition.auth === 'userAuth') {
                  const postGuards = getSlingshotCtx(c).routeAuth?.postGuards;
                  if (postGuards) {
                    for (const guard of postGuards) {
                      const failure = await guard(c);
                      if (failure) {
                        return c.json(
                          { error: failure.error, message: failure.message },
                          failure.status,
                        );
                      }
                    }
                  }
                }

                if (policyConfig && policyResolver) {
                  const input = await safeReadJsonBody(c);
                  try {
                    await resolvePolicy({
                      c,
                      config: policyConfig,
                      resolver: policyResolver,
                      action: buildPolicyAction(routeKey),
                      record: null,
                      input,
                      bus: getSlingshotCtx(c).bus,
                    });
                  } catch (error) {
                    if (error instanceof HTTPException) {
                      return c.json(
                        {
                          error: error.message,
                          requestId: c.get('requestId' as never) as string | undefined,
                        },
                        error.status,
                      );
                    }
                    throw error;
                  }
                }

                await next();
              }),
            );
          }

          if (routeDefinition.middleware?.length && pkg.middleware) {
            for (const middlewareName of routeDefinition.middleware) {
              const handler = pkg.middleware[middlewareName];
              if (handler) {
                router.use(routePath, methodGuard(routeDefinition.method, handler));
              }
            }
          }

          registerRoute(
            router,
            createRoute({
              method: routeDefinition.method,
              path: routePath,
              tags: [pkg.name, domain.name],
              summary: routeDefinition.summary ?? `${domain.name}:${routeDefinition.path}`,
              ...(routeDefinition.description ? { description: routeDefinition.description } : {}),
              ...(routeDefinition.request
                ? { request: buildTypedRouteRequest(routeDefinition.request) }
                : {}),
              responses: buildTypedRouteResponses(routeDefinition.responses),
            }),
            async c => {
              c.set('__packageRouteKey' as never, routeKey as never);
              const rawParams = c.req.param() as Record<string, string>;
              const rawQuery = Object.fromEntries(new URL(c.req.url).searchParams.entries());
              let rawBody: Record<string, unknown> | null = null;
              if (!['GET', 'HEAD', 'DELETE'].includes(c.req.method.toUpperCase())) {
                try {
                  rawBody = (await c.req.json()) as Record<string, unknown>;
                } catch {
                  rawBody = null;
                }
              }

              const parsedParams = parseTypedSection(c, routeDefinition.request?.params, rawParams);
              if (!parsedParams.success) return parsedParams.response;
              const parsedQuery = parseTypedSection(c, routeDefinition.request?.query, rawQuery);
              if (!parsedQuery.success) return parsedQuery.response;
              const parsedBody = parseTypedSection(c, routeDefinition.request?.body, rawBody ?? {});
              if (!parsedBody.success) return parsedBody.response;
              const body =
                routeDefinition.request?.body !== undefined || rawBody !== null
                  ? parsedBody.data
                  : rawBody;
              const actor = getActor(c);
              const params = parsedParams.data as Record<string, string>;
              const query = asObjectRecord(parsedQuery.data);
              const respond = createDomainRespond(c, routeKey);
              const requestContext = {
                actor,
                requestId: c.get('requestId' as never) as string | undefined,
              };
              const routeContext: PackageDomainRouteContext = {
                request: c,
                actor,
                packageName: pkg.name,
                params,
                query,
                body,
                input: normalizeRouteInput(params, query, body),
                requestContext,
                respond,
                capabilities: capabilityReaderFactory(ctx.app),
                entities: buildPackageEntityReader(ctx.app, pkg.name),
                services,
              };
              const response = await routeDefinition.handler(routeContext);
              emitRouteEvent(c, routeDefinition.event);
              return response;
            },
          );
        }
      }

      ctx.app.route('/', router);
      freezeEntityPolicyRegistry(ctx.app);
    },

    async setupPost(ctx) {
      await entityPlugin?.setupPost?.(ctx);
      await publishPackageRuntimeState(ctx.app, pkg);
    },

    async teardown() {
      await entityPlugin?.teardown?.();
    },
  };
}

export function compilePackages(packages: readonly SlingshotPackageDefinition[]): CompiledPackages {
  const capabilityProviders = new Map<string, string>();
  for (const pkg of packages) {
    for (const capability of pkg.capabilities.provides) {
      const existing = capabilityProviders.get(capability.capability.name);
      if (existing && existing !== pkg.name) {
        throw new Error(
          `Package capability '${capability.capability.name}' is published by both '${existing}' and '${pkg.name}'`,
        );
      }
      capabilityProviders.set(capability.capability.name, pkg.name);
    }
  }

  for (const pkg of packages) {
    for (const capability of pkg.capabilities.requires) {
      if (!capabilityProviders.has(capability.name)) {
        throw new Error(
          `Package '${pkg.name}' requires capability '${capability.name}' but no package provides it`,
        );
      }
    }
  }

  return {
    plugins: packages.map(pkg => createPackagePlugin(pkg, capabilityProviders)),
  };
}
