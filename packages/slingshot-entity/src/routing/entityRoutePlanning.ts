import type {
  NamedOpHttpMethod,
  OperationConfig,
  ResolvedEntityConfig,
  RouteEventConfig,
  RouteOperationConfig,
  TypedRouteContext,
  TypedRouteRequestSpec,
  TypedRouteResponses,
} from '@lastshotlabs/slingshot-core';
import { resolveOpConfig } from '@lastshotlabs/slingshot-core';
import { entityToPath } from '../generators/routeHelpers';
import { resolveNamedOperationRoute } from './namedOperationRouting';
import type { BareEntityAdapter } from './buildBareEntityRoutes';

export type EntityGeneratedRouteKey =
  | 'create'
  | 'list'
  | 'get'
  | 'update'
  | 'delete'
  | `operations.${string}`;

export interface EntityRouteExecutionContext<
  TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
> extends TypedRouteContext<TRequest> {
  request: import('hono').Context;
  entity: ResolvedEntityConfig;
  routeKey: string;
  generatedRouteKey?: EntityGeneratedRouteKey;
  entityAdapter: BareEntityAdapter;
  filter?: Record<string, unknown>;
  dataScopeBindings?: Record<string, unknown>;
  existingRecord?: unknown;
  getEntityAdapter(args: { plugin: string; entity: string }): BareEntityAdapter;
  setOpResult(opName: string, result: unknown): void;
}

export interface EntityRouteExecutorBuilderContext {
  entity: ResolvedEntityConfig;
  routeKey: string;
  generatedRouteKey?: EntityGeneratedRouteKey;
  entityAdapter: BareEntityAdapter;
  getEntityAdapter(args: { plugin: string; entity: string }): BareEntityAdapter;
}

export type EntityRouteExecutor<
  TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
> = (ctx: EntityRouteExecutionContext<TRequest>) => Response | Promise<Response>;

export type EntityRouteExecutorBuilder<
  TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
> = (
  ctx: EntityRouteExecutorBuilderContext,
) => EntityRouteExecutor<TRequest>;

export interface EntityRouteExecutorDefinition<
  TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
> {
  request?: TRequest;
  responses?: TypedRouteResponses;
  summary?: string;
  description?: string;
  build: EntityRouteExecutorBuilder<TRequest>;
}

export interface EntityExtraRoute<
  TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
> {
  key?: string;
  method: Lowercase<NamedOpHttpMethod> | 'delete' | 'patch';
  path: string;
  auth?: RouteOperationConfig['auth'];
  permission?: RouteOperationConfig['permission'];
  rateLimit?: RouteOperationConfig['rateLimit'];
  middleware?: readonly string[];
  event?: RouteOperationConfig['event'];
  summary?: string;
  description?: string;
  request?: TRequest;
  responses?: TypedRouteResponses;
  buildExecutor: EntityRouteExecutorBuilder<TRequest>;
}

export interface EntityRouteExecutorOverrides {
  create?: EntityRouteExecutorBuilder | EntityRouteExecutorDefinition;
  list?: EntityRouteExecutorBuilder | EntityRouteExecutorDefinition;
  get?: EntityRouteExecutorBuilder | EntityRouteExecutorDefinition;
  update?: EntityRouteExecutorBuilder | EntityRouteExecutorDefinition;
  delete?: EntityRouteExecutorBuilder | EntityRouteExecutorDefinition;
  operations?: Record<string, EntityRouteExecutorBuilder | EntityRouteExecutorDefinition>;
}

export interface PlannedEntityRoute {
  kind: 'generated' | 'extra';
  routeKey: string;
  opName: string;
  generatedRouteKey?: EntityGeneratedRouteKey;
  method: 'delete' | 'get' | 'head' | 'patch' | 'post' | 'put';
  path: string;
  relativePath: string;
  normalizedPath: string;
  specificity: number;
  routeConfig?: RouteOperationConfig;
  operationConfig?: OperationConfig;
  buildExecutor?: EntityRouteExecutorBuilder;
  summary?: string;
  description?: string;
  request?: TypedRouteRequestSpec;
  responses?: TypedRouteResponses;
}

export function defineEntityRoute<
  const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
>(route: EntityExtraRoute<TRequest>): EntityExtraRoute<TRequest> {
  return Object.freeze({
    ...route,
    middleware: route.middleware ? Object.freeze([...route.middleware]) : undefined,
    responses: route.responses ? Object.freeze({ ...route.responses }) : undefined,
  });
}

export function defineEntityExecutor(
  builder: EntityRouteExecutorBuilder,
): EntityRouteExecutorBuilder;
export function defineEntityExecutor<
  const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
>(
  definition: EntityRouteExecutorDefinition<TRequest>,
): EntityRouteExecutorDefinition<TRequest>;
export function defineEntityExecutor(
  builderOrDefinition: EntityRouteExecutorBuilder | EntityRouteExecutorDefinition,
): EntityRouteExecutorBuilder | EntityRouteExecutorDefinition {
  if (typeof builderOrDefinition === 'function') {
    return builderOrDefinition;
  }
  return Object.freeze({
    ...builderOrDefinition,
    responses: builderOrDefinition.responses
      ? Object.freeze({ ...builderOrDefinition.responses })
      : undefined,
  });
}

export function normalizeEntityRouteShape(path: string): string {
  return normalizeRoutePath(path)
    .split('/')
    .filter(Boolean)
    .map(segment => (segment.startsWith(':') ? ':' : segment))
    .join('/');
}

export function scoreEntityRouteSpecificity(path: string): number {
  const segments = normalizeRoutePath(path)
    .split('/')
    .filter(Boolean);
  return segments.reduce((score, segment) => score + (segment.startsWith(':') ? -10 : 1000), 0) + segments.length;
}

export function planEntityRoutes(
  entity: ResolvedEntityConfig,
  operations: Record<string, OperationConfig> | undefined,
  options?: {
    routePath?: string;
    parentPath?: string;
    extraRoutes?: readonly EntityExtraRoute[];
    overrides?: EntityRouteExecutorOverrides;
  },
): PlannedEntityRoute[] {
  const routes: PlannedEntityRoute[] = [];
  const disabled = new Set(entity.routes?.disable ?? []);
  const segment = joinEntitySegment(options?.parentPath, options?.routePath ?? entityToPath(entity.name));
  const collisions = new Map<string, PlannedEntityRoute>();
  const extraRoutes = options?.extraRoutes ?? [];
  const includeGeneratedRoutes = Boolean(entity.routes);

  if (!includeGeneratedRoutes && extraRoutes.length === 0) {
    return [];
  }

  const addRoute = (route: PlannedEntityRoute): void => {
    const collisionKey = `${route.method.toUpperCase()} ${route.normalizedPath}`;
    const existing = collisions.get(collisionKey);
    if (existing) {
      if (existing.kind === 'generated' || route.kind === 'generated') {
        const generated = existing.kind === 'generated' ? existing : route;
        const extra = existing.kind === 'extra' ? existing : route;
        const generatedHint =
          generated.generatedRouteKey === 'get'
            ? 'Use overrides.get instead.'
            : generated.generatedRouteKey === 'create'
              ? 'Use overrides.create instead.'
              : generated.generatedRouteKey === 'list'
                ? 'Use overrides.list instead.'
                : generated.generatedRouteKey === 'update'
                  ? 'Use overrides.update instead.'
                  : generated.generatedRouteKey === 'delete'
                    ? 'Use overrides.delete instead.'
                    : generated.generatedRouteKey?.startsWith('operations.')
                      ? `Use overrides.operations.${generated.opName} instead.`
                      : 'Use a generated route override instead.';
        throw new Error(
          `Entity route collision for '${entity.name}': ${extra.method.toUpperCase()} ${extra.path} ` +
            `conflicts with generated route '${generated.routeKey}'. ${generatedHint}`,
        );
      }

      throw new Error(
        `Entity route collision for '${entity.name}': ${route.method.toUpperCase()} ${route.path} ` +
          `conflicts with '${existing.routeKey}'.`,
      );
    }

    collisions.set(collisionKey, route);
    routes.push(route);
  };

  const addGeneratedRoute = (
    opName: string,
    generatedRouteKey: EntityGeneratedRouteKey,
    method: PlannedEntityRoute['method'],
    relativePath: string,
    operationConfig?: OperationConfig,
  ): void => {
    const fullPath = joinEntitySegment(segment, relativePath);
    if (routeDisabled(disabled, opName, method.toUpperCase(), fullPath)) {
      return;
    }
    const override = resolveGeneratedOverride(options?.overrides, generatedRouteKey, opName);
    addRoute({
      kind: 'generated',
      routeKey: generatedRouteKey,
      opName,
      generatedRouteKey,
      method,
      path: fullPath,
      relativePath,
      normalizedPath: normalizeEntityRouteShape(fullPath),
      specificity: scoreEntityRouteSpecificity(fullPath),
      routeConfig: entity.routes ? resolveOpConfig(entity.routes, opName) : undefined,
      operationConfig,
      buildExecutor: getEntityExecutorBuilder(override),
      summary: getEntityExecutorSummary(override),
      description: getEntityExecutorDescription(override),
      request: getEntityExecutorRequest(override),
      responses: getEntityExecutorResponses(override),
    });
  };

  if (includeGeneratedRoutes) {
    addGeneratedRoute('create', 'create', 'post', '/');
    addGeneratedRoute('list', 'list', 'get', '/');
    addGeneratedRoute('get', 'get', 'get', '/:id');
    addGeneratedRoute('update', 'update', 'patch', '/:id');
    addGeneratedRoute('delete', 'delete', 'delete', '/:id');

    for (const [opName, operationConfig] of Object.entries(operations ?? {})) {
      const namedRoute = resolveNamedOperationRoute(opName, operationConfig, {
        method: entity.routes?.operations?.[opName]?.method,
        path: entity.routes?.operations?.[opName]?.path,
      });
      addGeneratedRoute(
        opName,
        `operations.${opName}`,
        namedRoute.method,
        `/${namedRoute.path}`,
        operationConfig,
      );
    }
  }

  for (const extraRoute of extraRoutes) {
    const relativePath = normalizeExtraRoutePath(extraRoute.path);
    const fullPath = joinEntitySegment(segment, relativePath);
    const opName = extraRoute.key ?? deriveExtraRouteKey(relativePath, routes.length);
    addRoute({
      kind: 'extra',
      routeKey: `extra.${opName}`,
      opName,
      method: extraRoute.method,
      path: fullPath,
      relativePath,
      normalizedPath: normalizeEntityRouteShape(fullPath),
      specificity: scoreEntityRouteSpecificity(fullPath),
      routeConfig: buildExtraRouteConfig(extraRoute),
      buildExecutor: extraRoute.buildExecutor,
      summary: extraRoute.summary,
      description: extraRoute.description,
      request: extraRoute.request,
      responses: extraRoute.responses,
    });
  }

  return routes.sort((left, right) => {
    if (left.method !== right.method) {
      return left.method.localeCompare(right.method);
    }
    if (left.specificity !== right.specificity) {
      return right.specificity - left.specificity;
    }
    return left.path.localeCompare(right.path);
  });
}

function buildExtraRouteConfig(route: EntityExtraRoute): RouteOperationConfig {
  return {
    ...(route.auth ? { auth: route.auth } : {}),
    ...(route.permission ? { permission: route.permission } : {}),
    ...(route.rateLimit ? { rateLimit: route.rateLimit } : {}),
    ...(route.middleware ? { middleware: [...route.middleware] } : {}),
    ...(route.event ? { event: route.event as RouteEventConfig } : {}),
  };
}

function resolveGeneratedOverride(
  overrides: EntityRouteExecutorOverrides | undefined,
  routeKey: EntityGeneratedRouteKey,
  opName: string,
): EntityRouteExecutorBuilder | EntityRouteExecutorDefinition | undefined {
  switch (routeKey) {
    case 'create':
      return overrides?.create;
    case 'list':
      return overrides?.list;
    case 'get':
      return overrides?.get;
    case 'update':
      return overrides?.update;
    case 'delete':
      return overrides?.delete;
    default:
      return overrides?.operations?.[opName];
  }
}

function getEntityExecutorBuilder(
  override: EntityRouteExecutorBuilder | EntityRouteExecutorDefinition | undefined,
): EntityRouteExecutorBuilder | undefined {
  if (!override) return undefined;
  return typeof override === 'function' ? override : override.build;
}

function getEntityExecutorSummary(
  override: EntityRouteExecutorBuilder | EntityRouteExecutorDefinition | undefined,
): string | undefined {
  return typeof override === 'object' ? override.summary : undefined;
}

function getEntityExecutorDescription(
  override: EntityRouteExecutorBuilder | EntityRouteExecutorDefinition | undefined,
): string | undefined {
  return typeof override === 'object' ? override.description : undefined;
}

function getEntityExecutorRequest(
  override: EntityRouteExecutorBuilder | EntityRouteExecutorDefinition | undefined,
): TypedRouteRequestSpec | undefined {
  return typeof override === 'object' ? override.request : undefined;
}

function getEntityExecutorResponses(
  override: EntityRouteExecutorBuilder | EntityRouteExecutorDefinition | undefined,
): TypedRouteResponses | undefined {
  return typeof override === 'object' ? override.responses : undefined;
}

function normalizeRoutePath(path: string): string {
  const normalized = `/${path.replace(/^\/+/, '')}`.replace(/\/+/g, '/');
  return normalized === '/' ? normalized : normalized.replace(/\/$/, '');
}

function normalizeExtraRoutePath(path: string): string {
  const normalized = normalizeRoutePath(path);
  return normalized === '/' ? normalized : normalized;
}

function joinEntitySegment(base: string | undefined, child: string): string {
  const left = normalizeRoutePath(base ?? '/');
  const right = child === '/' ? '' : normalizeRoutePath(child);
  if (left === '/') {
    return right || '/';
  }
  return `${left}${right}`.replace(/\/+/g, '/');
}

function routeDisabled(
  disabled: ReadonlySet<string>,
  opName: string,
  method: string,
  path: string,
): boolean {
  const openApiPath = path.replace(/:([A-Za-z]\w*)/g, '{$1}');
  return (
    disabled.has(opName) ||
    disabled.has(`${method} ${path}`) ||
    disabled.has(`${method} ${openApiPath}`)
  );
}

function deriveExtraRouteKey(path: string, index: number): string {
  const segments = path
    .split('/')
    .filter(Boolean)
    .filter(segment => !segment.startsWith(':'));
  const basis = segments.at(-1) ?? `route-${index + 1}`;
  return basis.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}
