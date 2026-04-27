import type { Context, MiddlewareHandler } from 'hono';
import type { ZodTypeAny, z } from 'zod';
import type {
  RouteAuthConfig,
  RouteEventConfig,
  RouteIdempotencyConfig,
  RoutePermissionConfig,
  RouteRateLimitConfig,
} from './entityRouteConfig';
import type { Actor } from './identity';

type InferSchema<TSchema extends ZodTypeAny | undefined, TFallback> = TSchema extends ZodTypeAny
  ? z.infer<TSchema>
  : TFallback;

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type EmptyServices = Readonly<Record<never, never>>;
type AnyEntityModule = SlingshotPackageEntityModuleLike<unknown>;
type AnyDomainRouteDefinition = DomainRouteDefinition<unknown, TypedRouteRequestSpec>;
type AnyDomainModule = SlingshotPackageDomainModule<
  AnyDomainRouteDefinition,
  Readonly<Record<string, unknown>>
>;
type BivariantRouteHandler<TContext> = {
  bivarianceHack(context: TContext): Response | Promise<Response>;
}['bivarianceHack'];
type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (
  value: infer TResult,
) => void
  ? TResult
  : never;

export interface PackageCapabilityHandle<TValue> {
  /** Internal discriminator used by the package capability registry. */
  readonly kind: 'capability';
  /** Stable capability name used for publication, lookup, and diagnostics. */
  readonly name: string;
  /** Phantom generic marker so the capability's value type flows through IntelliSense. */
  readonly __value: TValue | undefined;
}

/** Publish and consume a typed cross-package contract without adapter bags or singleton registries. */
export interface PackageCapabilityProviderContext {
  /** Name of the package currently resolving the capability value. */
  readonly packageName: string;
}

/** Published capability resolver registered by a package during bootstrap. */
export interface PublishedPackageCapability<TValue> {
  /** Typed capability handle being published. */
  readonly capability: PackageCapabilityHandle<TValue>;
  /** Lazy resolver invoked when another package requires the capability. */
  readonly resolve: (context: PackageCapabilityProviderContext) => TValue | Promise<TValue>;
}

/** Request validation contract for package-authored domain routes. */
export interface TypedRouteRequestSpec {
  /** Zod schema for `:path` parameters. */
  readonly params?: ZodTypeAny;
  /** Zod schema for parsed query-string values. */
  readonly query?: ZodTypeAny;
  /** Zod schema for the JSON request body. */
  readonly body?: ZodTypeAny;
}

/** OpenAPI-oriented response metadata for package-authored domain routes. */
export interface TypedRouteResponseSpec {
  /** Human-readable OpenAPI description for this status code. */
  readonly description: string;
  /** Response content type. Defaults to `application/json` when omitted. */
  readonly contentType?: string;
  /** Optional Zod schema used to document the response payload. */
  readonly schema?: ZodTypeAny;
}

/** Response metadata keyed by HTTP status code. */
export type TypedRouteResponses = Record<number, TypedRouteResponseSpec>;

/** Canonical request metadata exposed to package-authored route handlers. */
export interface PackageRouteRequestContext {
  /** Canonical actor identity resolved for the current request. */
  readonly actor: Actor;
  /** Framework request id when request-id middleware is active. */
  readonly requestId?: string;
}

/** Inferred typed request values exposed to a domain route handler. */
export interface TypedRouteValidation<
  TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
> {
  /** Parsed path params, validated against `request.params` when provided. */
  readonly params: InferSchema<TRequest['params'], Record<string, string>>;
  /** Parsed query values, validated against `request.query` when provided. */
  readonly query: InferSchema<TRequest['query'], Record<string, unknown>>;
  /** Parsed JSON body, validated against `request.body` when provided. */
  readonly body: InferSchema<TRequest['body'], Record<string, unknown> | null> | null;
}

/**
 * Best-effort binding input exposed for handler convenience.
 *
 * Object bodies are merged with params/query at runtime. Array and primitive bodies are
 * passed through directly because they cannot be meaningfully merged into a record.
 */
export type TypedRouteInput<TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec> = [
  Extract<NonNullable<TypedRouteValidation<TRequest>['body']>, Record<string, unknown>>,
] extends [never]
  ?
      | TypedRouteValidation<TRequest>['body']
      | Simplify<TypedRouteValidation<TRequest>['params'] & TypedRouteValidation<TRequest>['query']>
      | null
  :
      | Simplify<
          TypedRouteValidation<TRequest>['params'] &
            TypedRouteValidation<TRequest>['query'] &
            Extract<NonNullable<TypedRouteValidation<TRequest>['body']>, Record<string, unknown>>
        >
      | Exclude<TypedRouteValidation<TRequest>['body'], Record<string, unknown> | null | undefined>
      | null;

/** Minimal responder helpers available inside package-authored route handlers. */
export interface TypedRouteRespond {
  /** Return a JSON response. */
  json(data: unknown, status?: number): Response;
  /** Return a plain-text response. */
  text(data: string, status?: number): Response;
  /** Return an HTML response. */
  html(data: string, status?: number): Response;
  /** Return a raw `Response` body with optional headers. */
  body(data: BodyInit | null | undefined, status?: number, headers?: HeadersInit): Response;
  /** Return a 204 response. */
  noContent(): Response;
  /** Return a 404 JSON response, optionally overriding the default message. */
  notFound(message?: string): Response;
}

/** Common request context shared by package-authored domain route handlers. */
export interface TypedRouteContext<
  TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
> extends TypedRouteValidation<TRequest> {
  /** Underlying Hono request context for escape-hatch access. */
  readonly request: Context;
  /** Canonical actor identity resolved for the current request. */
  readonly actor: Actor;
  /**
   * Best-effort binding input view used by named-operation and custom handler code.
   *
   * Object bodies are merged with validated params/query. Array and primitive bodies are
   * passed through unchanged.
   */
  readonly input: TypedRouteInput<TRequest>;
  /** Framework-owned request metadata, including canonical actor and request id. */
  readonly requestContext: PackageRouteRequestContext;
  /** Response helper methods for common return shapes. */
  readonly respond: TypedRouteRespond;
}

/** Typed capability lookup helpers exposed to package domain routes. */
export interface PackageCapabilityReader {
  /** Return a capability when available, otherwise `undefined`. */
  maybe<TValue>(capability: PackageCapabilityHandle<TValue>): TValue | undefined;
  /** Return a capability or throw during bootstrap/request handling if it is missing. */
  require<TValue>(capability: PackageCapabilityHandle<TValue>): TValue;
}

/** Lightweight typed entity handle used for package-local and cross-package adapter lookups. */
export interface PackageEntityRef<TAdapter = unknown> {
  /** Internal discriminator for typed entity lookup tokens. */
  readonly kind: 'entity-ref';
  /** Optional plugin/package owner when the entity is not local to the current package. */
  readonly plugin?: string;
  /** Entity name as registered with the framework. */
  readonly entity: string;
  /** Phantom generic marker so the entity adapter type flows through IntelliSense. */
  readonly __adapter: TAdapter | undefined;
}

/** Minimal entity module contract shared between `slingshot-core` and `slingshot-entity`. */
export interface SlingshotPackageEntityModuleLike<TAdapter = unknown> {
  /** Internal discriminator for package entity modules. */
  readonly kind: 'entity';
  /** Module name used for diagnostics and inspection. */
  readonly name: string;
  /** Entity config name registered with the framework. */
  readonly entityName: string;
  /** Optional path override relative to the package mount path. */
  readonly path?: string;
  /** Phantom generic marker so the entity adapter type flows through IntelliSense. */
  readonly __adapter: TAdapter | undefined;
  /** Implementation details supplied by `slingshot-entity`. */
  readonly implementation: unknown;
}

/** Lookup helper for framework-managed entity adapters owned by the app. */
export interface PackageEntityReader {
  /** Resolve an adapter from a typed package-owned entity module or typed entity ref. */
  get<TEntity extends SlingshotPackageEntityModuleLike<unknown>>(
    entity: TEntity,
  ): Exclude<TEntity['__adapter'], undefined>;
  /** Resolve an adapter from a typed cross-package entity ref. */
  get<TEntity extends PackageEntityRef<unknown>>(
    entity: TEntity,
  ): Exclude<TEntity['__adapter'], undefined>;
  /** Escape hatch: resolve an entity adapter by name. */
  get<TValue = unknown>(args: { entity: string; plugin?: string }): TValue;
}

/** Full handler context available to package-authored domain routes. */
export interface PackageDomainRouteContext<
  TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
  TServices extends Readonly<Record<string, unknown>> = EmptyServices,
> extends TypedRouteContext<TRequest> {
  /** Name of the currently executing package. */
  readonly packageName: string;
  /** Typed capability reader for cross-package dependencies. */
  readonly capabilities: PackageCapabilityReader;
  /** Entity adapter lookup for package/domain handlers. */
  readonly entities: PackageEntityReader;
  /** Domain-local service bag declared on the domain module. */
  readonly services: TServices;
}

/** Domain route contract used by package-first authoring and compiled into framework routes. */
export interface DomainRouteDefinition<
  TContext = PackageDomainRouteContext,
  TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
> {
  /** Internal discriminator for package-authored domain routes. */
  readonly kind: 'domain-route';
  /** HTTP verb used to mount the route. */
  readonly method: 'delete' | 'get' | 'head' | 'patch' | 'post' | 'put';
  /** Route path relative to the domain module base path. */
  readonly path: string;
  /** Route auth contract applied by the framework-owned route shell. */
  readonly auth?: RouteAuthConfig;
  /** Permission contract enforced before the handler runs. */
  readonly permission?: RoutePermissionConfig;
  /** Optional rate limit configuration scoped to the route. */
  readonly rateLimit?: RouteRateLimitConfig;
  /** Optional idempotency configuration for unsafe methods. */
  readonly idempotency?: boolean | RouteIdempotencyConfig;
  /** Named middleware entries declared by the package and applied in-order. */
  readonly middleware?: readonly string[];
  /** Optional event publication metadata emitted after successful handler execution. */
  readonly event?: RouteEventConfig;
  /** Entity adapter used when permission checks need entity-aware context. */
  readonly permissionAdapter?: PackageEntityRef;
  /** Entity adapter used when parent/ownership checks need entity-aware context. */
  readonly parentAdapter?: PackageEntityRef;
  /** Short OpenAPI summary shown in generated docs. */
  readonly summary?: string;
  /** Longer OpenAPI description shown in generated docs. */
  readonly description?: string;
  /** Optional typed request specification for validation and OpenAPI generation. */
  readonly request?: TRequest;
  /** Optional typed response metadata for OpenAPI generation. */
  readonly responses?: TypedRouteResponses;
  /** Route handler executed after framework auth/permission/policy/idempotency middleware. */
  readonly handler: BivariantRouteHandler<TContext>;
}

/** Non-entity route group owned by a package. */
export interface SlingshotPackageDomainModule<
  TRoute extends AnyDomainRouteDefinition = AnyDomainRouteDefinition,
  TServices extends Readonly<Record<string, unknown>> = EmptyServices,
> {
  /** Internal discriminator for package domain modules. */
  readonly kind: 'domain';
  /** Stable domain module name used for inspection and diagnostics. */
  readonly name: string;
  /** Base path relative to the package mount path. */
  readonly basePath?: string;
  /** Routes declared under this domain module. */
  readonly routes: readonly TRoute[];
  /** Arbitrary domain-local services exposed to each route handler. */
  readonly services?: TServices;
}

/** Any module that can be owned by a package definition. */
export type SlingshotPackageModule = AnyEntityModule | AnyDomainModule;

/** Immutable package definition consumed by `createApp({ packages })`. */
export interface SlingshotPackageDefinition {
  /** Internal discriminator for package definitions. */
  readonly kind: 'package';
  /** Stable package name used for dependency ordering and diagnostics. */
  readonly name: string;
  /** Optional base mount path shared by the package's entities and domains. */
  readonly mountPath?: string;
  /** Other plugins/packages that must be installed before this package. */
  readonly dependencies?: readonly string[];
  /** Entity modules owned by this package. */
  readonly entities: readonly AnyEntityModule[];
  /** Domain modules owned by this package. */
  readonly domains: readonly AnyDomainModule[];
  /** Named middleware available to entity and domain routes in this package. */
  readonly middleware?: Readonly<Record<string, MiddlewareHandler>>;
  /** Typed capability contracts published and required by the package. */
  readonly capabilities: {
    /** Capability implementations made available to other packages. */
    readonly provides: readonly PublishedPackageCapability<unknown>[];
    /** Capability handles this package expects to be available. */
    readonly requires: readonly PackageCapabilityHandle<unknown>[];
  };
  /** Paths that should bypass tenant resolution. */
  readonly tenantExemptPaths?: readonly string[];
  /** Paths that should bypass CSRF protection. */
  readonly csrfExemptPaths?: readonly string[];
  /** Publicly accessible paths added by the package. */
  readonly publicPaths?: readonly string[];
}

/** Input contract for `definePackage(...)`. */
export interface DefinePackageInput {
  /** Stable package name used for dependency ordering and diagnostics. */
  readonly name: string;
  /** Optional base mount path shared by the package's entities and domains. */
  readonly mountPath?: string;
  /** Other plugins/packages that must be installed before this package. */
  readonly dependencies?: readonly string[];
  /** Entity modules owned by the package. */
  readonly entities?: readonly AnyEntityModule[];
  /** Domain modules owned by the package. */
  readonly domains?: readonly AnyDomainModule[];
  /** Named middleware made available to package routes. */
  readonly middleware?: Readonly<Record<string, MiddlewareHandler>>;
  /** Capability contracts published and required by the package. */
  readonly capabilities?: {
    /** Capability implementations made available to other packages. */
    readonly provides?: readonly PublishedPackageCapability<unknown>[];
    /** Capability handles this package expects to consume. */
    readonly requires?: readonly PackageCapabilityHandle<unknown>[];
  };
  /** Paths that should bypass tenant resolution. */
  readonly tenantExemptPaths?: readonly string[];
  /** Paths that should bypass CSRF protection. */
  readonly csrfExemptPaths?: readonly string[];
  /** Publicly accessible paths added by the package. */
  readonly publicPaths?: readonly string[];
}

/** Static inspection output for a package's effective modules and capability graph. */
export interface PackageInspection {
  /** Package name. */
  readonly name: string;
  /** Effective package mount path, normalized to `''` when omitted. */
  readonly mountPath: string;
  /** Declared package/plugin dependencies. */
  readonly dependencies: readonly string[];
  /** Named middleware keys available to package routes. */
  readonly middleware: readonly string[];
  readonly entities: ReadonlyArray<{
    /** Package-local entity module name. */
    readonly name: string;
    /** Registered entity config name. */
    readonly entityName: string;
    /** Explicit path override, if one was declared. */
    readonly path: string | null;
    /** Effective mount path after package-level normalization. */
    readonly resolvedPath: string;
    /** Wiring mode used to resolve the entity adapter. */
    readonly wiringMode: 'standard' | 'factories' | 'manual' | 'unknown';
  }>;
  readonly domains: ReadonlyArray<{
    /** Domain module name. */
    readonly name: string;
    /** Explicit base path override, if one was declared. */
    readonly basePath: string | null;
    /** Effective base path after package-level normalization. */
    readonly resolvedBasePath: string;
    /** Route summary strings in `METHOD /path` form. */
    readonly routes: readonly string[];
    readonly routeDetails: ReadonlyArray<{
      /** HTTP method in uppercase form. */
      readonly method: string;
      /** Route path relative to the domain base path. */
      readonly path: string;
      /** Effective fully resolved route path. */
      readonly resolvedPath: string;
      /** Effective auth declaration, if any. */
      readonly auth?: RouteAuthConfig;
      /** Whether the route declares a permission contract. */
      readonly hasPermission: boolean;
      /** Whether the route emits an event after execution. */
      readonly hasEvent: boolean;
      /** Whether the route enables idempotency. */
      readonly idempotency?: boolean | RouteIdempotencyConfig;
      /** Resolved permission adapter reference used by the route. */
      readonly permissionAdapter?: string;
      /** Resolved parent adapter reference used by the route. */
      readonly parentAdapter?: string;
    }>;
  }>;
  readonly capabilities: {
    /** Capability names published by the package. */
    readonly provides: readonly string[];
    /** Capability names required by the package. */
    readonly requires: readonly string[];
  };
}

function freezeReadonlyArray<T>(items: readonly T[] | undefined): readonly T[] {
  return Object.freeze([...(items ?? [])]);
}

function freezeReadonlyRecord<TValue>(
  record: Readonly<Record<string, TValue>> | undefined,
): Readonly<Record<string, TValue>> | undefined {
  if (!record) return undefined;
  return Object.freeze({ ...record });
}

function pluralizeSegment(word: string): string {
  if (/(s|ss|sh|ch|x|z)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function entityNameToPath(name: string): string {
  const kebab = name
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '');
  const parts = kebab.split('-');
  parts[parts.length - 1] = pluralizeSegment(parts[parts.length - 1]);
  return parts.join('-');
}

function normalizeInspectionPath(base: string | undefined, child: string | undefined): string {
  const left = base ? `/${base.replace(/^\/+|\/+$/g, '')}` : '';
  const right = child ? `/${child.replace(/^\/+|\/+$/g, '')}` : '';
  const combined = `${left}${right}`.replace(/\/+/g, '/');
  return combined === '' ? '/' : combined;
}

function resolveEntityModuleWiringMode(
  entityModule: SlingshotPackageEntityModuleLike,
): 'standard' | 'factories' | 'manual' | 'unknown' {
  const implementation =
    typeof entityModule.implementation === 'object' && entityModule.implementation !== null
      ? (entityModule.implementation as {
          wiring?: {
            mode?: 'standard' | 'factories' | 'manual';
          };
        })
      : null;
  const mode = implementation?.wiring?.mode;
  return mode ?? 'standard';
}

function formatEntityRef(ref: PackageEntityRef | undefined): string | undefined {
  if (!ref) return undefined;
  return ref.plugin ? `${ref.plugin}:${ref.entity}` : ref.entity;
}

/**
 * Create a typed entity ref that can be used outside the owning package.
 *
 * Pass a local entity module for same-package typed lookups, or attach `plugin`
 * when exporting a ref for another package to consume.
 */
export function entityRef<TAdapter>(
  entity: SlingshotPackageEntityModuleLike<TAdapter>,
  options?: { plugin?: string },
): PackageEntityRef<TAdapter>;
/** Create a typed entity ref directly from a package/entity name pair. */
export function entityRef<TAdapter>(args: {
  entity: string;
  plugin?: string;
}): PackageEntityRef<TAdapter>;
export function entityRef<TAdapter>(
  input: SlingshotPackageEntityModuleLike<TAdapter> | { entity: string; plugin?: string },
  options?: { plugin?: string },
): PackageEntityRef<TAdapter> {
  if ('kind' in input && input.kind === 'entity') {
    return Object.freeze({
      kind: 'entity-ref' as const,
      plugin: options?.plugin,
      entity: input.entityName,
      __adapter: undefined,
    }) as PackageEntityRef<TAdapter>;
  }
  const args = input as { entity: string; plugin?: string };
  return Object.freeze({
    kind: 'entity-ref' as const,
    plugin: args.plugin,
    entity: args.entity,
    __adapter: undefined,
  }) as PackageEntityRef<TAdapter>;
}

function defineDomainRoute<
  TContext,
  const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
>(
  method: DomainRouteDefinition<TContext, TRequest>['method'],
  config: Omit<DomainRouteDefinition<TContext, TRequest>, 'kind' | 'method'>,
): DomainRouteDefinition<TContext, TRequest> {
  return Object.freeze({
    ...config,
    kind: 'domain-route' as const,
    method,
    idempotency:
      typeof config.idempotency === 'object' && config.idempotency !== null
        ? Object.freeze({ ...config.idempotency })
        : config.idempotency,
    middleware: config.middleware ? freezeReadonlyArray(config.middleware) : undefined,
    permissionAdapter: config.permissionAdapter
      ? Object.freeze({ ...config.permissionAdapter })
      : undefined,
    parentAdapter: config.parentAdapter ? Object.freeze({ ...config.parentAdapter }) : undefined,
    responses: config.responses ? Object.freeze({ ...config.responses }) : undefined,
  });
}

type PackageRouteBuilder = {
  get<
    const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
    TContext = PackageDomainRouteContext<TRequest>,
  >(
    config: Omit<DomainRouteDefinition<TContext, TRequest>, 'kind' | 'method'>,
  ): DomainRouteDefinition<TContext, TRequest>;
  post<
    const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
    TContext = PackageDomainRouteContext<TRequest>,
  >(
    config: Omit<DomainRouteDefinition<TContext, TRequest>, 'kind' | 'method'>,
  ): DomainRouteDefinition<TContext, TRequest>;
  put<
    const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
    TContext = PackageDomainRouteContext<TRequest>,
  >(
    config: Omit<DomainRouteDefinition<TContext, TRequest>, 'kind' | 'method'>,
  ): DomainRouteDefinition<TContext, TRequest>;
  patch<
    const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
    TContext = PackageDomainRouteContext<TRequest>,
  >(
    config: Omit<DomainRouteDefinition<TContext, TRequest>, 'kind' | 'method'>,
  ): DomainRouteDefinition<TContext, TRequest>;
  delete<
    const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
    TContext = PackageDomainRouteContext<TRequest>,
  >(
    config: Omit<DomainRouteDefinition<TContext, TRequest>, 'kind' | 'method'>,
  ): DomainRouteDefinition<TContext, TRequest>;
  head<
    const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
    TContext = PackageDomainRouteContext<TRequest>,
  >(
    config: Omit<DomainRouteDefinition<TContext, TRequest>, 'kind' | 'method'>,
  ): DomainRouteDefinition<TContext, TRequest>;
};

function createRouteBuilder(): PackageRouteBuilder {
  return {
    /** Declare a package-owned `GET` route. */
    get<
      const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
      TContext = PackageDomainRouteContext<TRequest>,
    >(config: Omit<DomainRouteDefinition<TContext, TRequest>, 'kind' | 'method'>) {
      return defineDomainRoute<TContext, TRequest>('get', config);
    },
    /** Declare a package-owned `POST` route. */
    post<
      const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
      TContext = PackageDomainRouteContext<TRequest>,
    >(config: Omit<DomainRouteDefinition<TContext, TRequest>, 'kind' | 'method'>) {
      return defineDomainRoute<TContext, TRequest>('post', config);
    },
    /** Declare a package-owned `PUT` route. */
    put<
      const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
      TContext = PackageDomainRouteContext<TRequest>,
    >(config: Omit<DomainRouteDefinition<TContext, TRequest>, 'kind' | 'method'>) {
      return defineDomainRoute<TContext, TRequest>('put', config);
    },
    /** Declare a package-owned `PATCH` route. */
    patch<
      const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
      TContext = PackageDomainRouteContext<TRequest>,
    >(config: Omit<DomainRouteDefinition<TContext, TRequest>, 'kind' | 'method'>) {
      return defineDomainRoute<TContext, TRequest>('patch', config);
    },
    /** Declare a package-owned `DELETE` route. */
    delete<
      const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
      TContext = PackageDomainRouteContext<TRequest>,
    >(config: Omit<DomainRouteDefinition<TContext, TRequest>, 'kind' | 'method'>) {
      return defineDomainRoute<TContext, TRequest>('delete', config);
    },
    /** Declare a package-owned `HEAD` route. */
    head<
      const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec,
      TContext = PackageDomainRouteContext<TRequest>,
    >(config: Omit<DomainRouteDefinition<TContext, TRequest>, 'kind' | 'method'>) {
      return defineDomainRoute<TContext, TRequest>('head', config);
    },
  };
}

type ServiceAwareRouteBuilder<TServices extends Readonly<Record<string, unknown>>> = {
  get<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
    config: Omit<
      DomainRouteDefinition<PackageDomainRouteContext<TRequest, TServices>, TRequest>,
      'kind' | 'method'
    >,
  ): DomainRouteDefinition<PackageDomainRouteContext<TRequest, TServices>, TRequest>;
  post<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
    config: Omit<
      DomainRouteDefinition<PackageDomainRouteContext<TRequest, TServices>, TRequest>,
      'kind' | 'method'
    >,
  ): DomainRouteDefinition<PackageDomainRouteContext<TRequest, TServices>, TRequest>;
  put<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
    config: Omit<
      DomainRouteDefinition<PackageDomainRouteContext<TRequest, TServices>, TRequest>,
      'kind' | 'method'
    >,
  ): DomainRouteDefinition<PackageDomainRouteContext<TRequest, TServices>, TRequest>;
  patch<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
    config: Omit<
      DomainRouteDefinition<PackageDomainRouteContext<TRequest, TServices>, TRequest>,
      'kind' | 'method'
    >,
  ): DomainRouteDefinition<PackageDomainRouteContext<TRequest, TServices>, TRequest>;
  delete<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
    config: Omit<
      DomainRouteDefinition<PackageDomainRouteContext<TRequest, TServices>, TRequest>,
      'kind' | 'method'
    >,
  ): DomainRouteDefinition<PackageDomainRouteContext<TRequest, TServices>, TRequest>;
  head<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
    config: Omit<
      DomainRouteDefinition<PackageDomainRouteContext<TRequest, TServices>, TRequest>,
      'kind' | 'method'
    >,
  ): DomainRouteDefinition<PackageDomainRouteContext<TRequest, TServices>, TRequest>;
};

function createServiceAwareRouteBuilder<
  TServices extends Readonly<Record<string, unknown>>,
>(): ServiceAwareRouteBuilder<TServices> {
  return createRouteBuilder() as ServiceAwareRouteBuilder<TServices>;
}

type DomainRouteServiceRequirements<TRoute extends AnyDomainRouteDefinition> = Simplify<
  UnionToIntersection<
    TRoute extends DomainRouteDefinition<infer TCtx, TypedRouteRequestSpec>
      ? TCtx extends PackageDomainRouteContext<TypedRouteRequestSpec, infer TServices>
        ? TServices
        : EmptyServices
      : EmptyServices
  >
>;

type DomainDefinitionInput<
  TRoute extends AnyDomainRouteDefinition,
  TServices extends DomainRouteServiceRequirements<TRoute>,
> = {
  readonly name: string;
  readonly basePath?: string;
  readonly routes: readonly TRoute[];
} & ([keyof DomainRouteServiceRequirements<TRoute>] extends [never]
  ? {
      /** Optional domain-local services exposed to each route handler. */
      readonly services?: TServices;
    }
  : {
      /** Domain-local services must satisfy the combined requirements of the route set. */
      readonly services: TServices;
    });

export const route = Object.freeze({
  ...createRouteBuilder(),
  /**
   * Bind `ctx.services` to a specific service bag shape for stronger handler IntelliSense.
   *
   * The enclosing `domain({ services })` call is checked against the combined
   * requirements of every `withServices()` route in that domain.
   */
  withServices<TServices extends Readonly<Record<string, unknown>>>() {
    return createServiceAwareRouteBuilder<TServices>();
  },
});

/** Declare a named typed capability that packages can publish and require explicitly. */
export function defineCapability<TValue>(name: string): PackageCapabilityHandle<TValue> {
  return Object.freeze({
    kind: 'capability' as const,
    name,
    __value: undefined,
  }) as PackageCapabilityHandle<TValue>;
}

/** Publish a capability implementation from a package during bootstrap finalization. */
export function provideCapability<TValue>(
  capability: PackageCapabilityHandle<TValue>,
  resolve: PublishedPackageCapability<TValue>['resolve'],
): PublishedPackageCapability<TValue> {
  return Object.freeze({
    capability,
    resolve,
  });
}

/** Declare a package-owned non-entity route group and optional domain-local services. */
export function domain<
  const TRoute extends AnyDomainRouteDefinition = AnyDomainRouteDefinition,
  const TServices extends DomainRouteServiceRequirements<TRoute> =
    DomainRouteServiceRequirements<TRoute>,
>(
  config: DomainDefinitionInput<TRoute, TServices>,
): SlingshotPackageDomainModule<TRoute, TServices> {
  return Object.freeze({
    kind: 'domain' as const,
    name: config.name,
    basePath: config.basePath,
    routes: freezeReadonlyArray(config.routes),
    services: freezeReadonlyRecord(config.services) as TServices | undefined,
  }) as SlingshotPackageDomainModule<TRoute, TServices>;
}

/** Canonical top-level code-first authoring surface for packages. */
export function definePackage(input: DefinePackageInput): SlingshotPackageDefinition {
  return Object.freeze({
    kind: 'package' as const,
    name: input.name,
    mountPath: input.mountPath,
    dependencies: freezeReadonlyArray(input.dependencies),
    entities: freezeReadonlyArray(input.entities),
    domains: freezeReadonlyArray(input.domains),
    middleware: freezeReadonlyRecord(input.middleware),
    capabilities: Object.freeze({
      provides: freezeReadonlyArray(input.capabilities?.provides),
      requires: freezeReadonlyArray(input.capabilities?.requires),
    }),
    tenantExemptPaths: freezeReadonlyArray(input.tenantExemptPaths),
    csrfExemptPaths: freezeReadonlyArray(input.csrfExemptPaths),
    publicPaths: freezeReadonlyArray(input.publicPaths),
  });
}

/** Inspect the effective module graph of a package without reading framework internals. */
export function inspectPackage(pkg: SlingshotPackageDefinition): PackageInspection {
  return Object.freeze({
    name: pkg.name,
    mountPath: pkg.mountPath ?? '',
    dependencies: freezeReadonlyArray(pkg.dependencies),
    middleware: Object.freeze(Object.keys(pkg.middleware ?? {})),
    entities: Object.freeze(
      pkg.entities.map(entityModule =>
        Object.freeze({
          name: entityModule.name,
          entityName: entityModule.entityName,
          path: entityModule.path ?? null,
          resolvedPath: normalizeInspectionPath(
            pkg.mountPath,
            entityModule.path ?? entityNameToPath(entityModule.entityName),
          ),
          wiringMode: resolveEntityModuleWiringMode(entityModule),
        }),
      ),
    ),
    domains: Object.freeze(
      pkg.domains.map(domainModule => {
        const resolvedBasePath = normalizeInspectionPath(pkg.mountPath, domainModule.basePath);
        return Object.freeze({
          name: domainModule.name,
          basePath: domainModule.basePath ?? null,
          resolvedBasePath,
          routes: Object.freeze(
            domainModule.routes.map(
              routeDefinition =>
                `${routeDefinition.method.toUpperCase()} ${normalizeInspectionPath(
                  resolvedBasePath,
                  routeDefinition.path,
                )}`,
            ),
          ),
          routeDetails: Object.freeze(
            domainModule.routes.map(routeDefinition =>
              Object.freeze({
                method: routeDefinition.method.toUpperCase(),
                path: routeDefinition.path,
                resolvedPath: normalizeInspectionPath(resolvedBasePath, routeDefinition.path),
                auth: routeDefinition.auth,
                hasPermission: Boolean(routeDefinition.permission),
                hasEvent: Boolean(routeDefinition.event),
                idempotency: routeDefinition.idempotency,
                permissionAdapter: formatEntityRef(routeDefinition.permissionAdapter),
                parentAdapter: formatEntityRef(routeDefinition.parentAdapter),
              }),
            ),
          ),
        });
      }),
    ),
    capabilities: Object.freeze({
      provides: Object.freeze(pkg.capabilities.provides.map(entry => entry.capability.name)),
      requires: Object.freeze(pkg.capabilities.requires.map(entry => entry.name)),
    }),
  });
}
