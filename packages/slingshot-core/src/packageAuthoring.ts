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
type InferBody<TSchema extends ZodTypeAny | undefined> = TSchema extends ZodTypeAny
  ? z.infer<TSchema>
  : Record<string, unknown> | null;

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type EmptyServices = Readonly<Record<never, never>>;
type AnyEntityModule = SlingshotPackageEntityModuleLike<unknown, string>;
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
  /**
   * Owning package contract name when the handle was created via `definePackageContract`.
   * Free-floating capabilities created through `defineCapability(...)` leave this undefined.
   */
  readonly contract?: string;
  /** Source location (`file:line:col`) where the capability was declared, when available. */
  readonly source?: string;
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
  /**
   * Optional DTO variant name — only honored on entity-generated routes
   * (CRUD plus entity custom ops), where the framework knows which entity's
   * `dto` map to look up against. The selected `entity.dto[variant]` mapper
   * runs in place of `dto.default` for this status.
   *
   * For package-domain routes that have no implicit entity context, pass the
   * variant function directly via `transform` (e.g. `transform: User.dto.admin`).
   * For standard CRUD routes prefer `routes.<op>.dto`, which gives the same
   * effect declared at the route-config level.
   *
   * If the named variant is missing from `entity.dto`, the framework logs a
   * one-time warning and falls through to no projection.
   */
  readonly dto?: string;
  /**
   * Optional transform run on the response body before serialization. Receives
   * whatever the handler passed to `respond.json(...)` and returns the value
   * actually sent on the wire. Use this to project storage records into
   * API DTOs, redact internal fields, or coerce types.
   *
   * Runs after entity-level DTO mapping (private-field stripping plus the
   * selected `dto[variant]` mapper). Pass a `createDtoMapper(...)` result
   * here for typed shape mapping.
   */
  readonly transform?: (value: unknown) => unknown;
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
  readonly body: InferBody<TRequest['body']>;
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

/**
 * Default entity adapter surface returned by string-based `entityRef(...)`.
 *
 * Entity-module refs still carry precise generated adapter types. String refs cannot
 * infer a concrete record shape at compile time, but they should still expose the
 * framework-owned CRUD method surface instead of forcing every package to hand-write
 * ad hoc adapter types.
 */
export interface PackageEntityAdapter<
  TEntity extends Record<string, unknown> = Record<string, unknown> & {
    id: string | number;
  },
  TCreateInput extends Record<string, unknown> = Record<string, unknown>,
  TUpdateInput extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Allow generated operation methods to exist alongside CRUD. */
  readonly [operation: string]: unknown;
  create?(input: TCreateInput): Promise<TEntity>;
  getById?(id: string | number, filter?: Record<string, unknown>): Promise<TEntity | null>;
  find?(filter: Record<string, unknown>): Promise<PackageEntityCollection<TEntity>>;
  list?(opts?: Record<string, unknown>): Promise<PackageEntityCollection<TEntity>>;
  update?(
    id: string | number,
    input: TUpdateInput,
    filter?: Record<string, unknown>,
  ): Promise<TEntity | null>;
  delete?(id: string | number, filter?: Record<string, unknown>): Promise<boolean>;
  clear?(): Promise<void>;
}

/**
 * Collection shape exposed by the generic entity adapter. Generated adapters normally return
 * arrays from ad hoc `find(...)` helpers and paginated envelopes from `list(...)`; this shape keeps
 * package-domain code ergonomic for both defensive styles while preserving item typing.
 */
export interface PackageEntityCollection<
  TEntity extends Record<string, unknown>,
> extends Iterable<TEntity> {
  readonly length: number;
  readonly [index: number]: TEntity;
  readonly items?: TEntity[];
  readonly cursor?: string;
  readonly nextCursor?: string;
  readonly hasMore?: boolean;
}

/** Exposure mode declared by a package contract for a public entity ref. */
export type PublicEntityExposureMode = 'readonly' | 'as' | 'unsafeFullAdapter';

/**
 * Metadata captured when a package contract publishes an entity ref. `runtimeEnforced`
 * is `true` for `readonly` mode (the framework wraps the adapter to expose only the
 * declared methods) and `false` for `as` and `unsafeFullAdapter` modes, where the
 * runtime returns the full underlying adapter.
 */
export interface PublicEntityExposureMetadata {
  /** Exposure mode chosen when the entity was published. */
  readonly mode: PublicEntityExposureMode;
  /** Method names declared on `readonly([...])` exposure mode. */
  readonly methods?: readonly string[];
  /** Whether the framework restricts the adapter surface at lookup time. */
  readonly runtimeEnforced: boolean;
}

/** Lightweight typed entity handle used for package-local and cross-package adapter lookups. */
export interface PackageEntityRef<TAdapter = PackageEntityAdapter> {
  /** Internal discriminator for typed entity lookup tokens. */
  readonly kind: 'entity-ref';
  /** Optional plugin/package owner when the entity is not local to the current package. */
  readonly plugin?: string;
  /** Entity name as registered with the framework. */
  readonly entity: string;
  /**
   * Owning package contract name when the ref was published via `Matches.publicEntities(...)`.
   * Refs created through the legacy `entityRef(...)` factory leave this undefined.
   */
  readonly contract?: string;
  /** Public adapter exposure metadata when the ref was published via a contract. */
  readonly exposure?: PublicEntityExposureMetadata;
  /** Source location (`file:line:col`) where this ref was authored, when available. */
  readonly source?: string;
  /** Phantom generic marker so the entity adapter type flows through IntelliSense. */
  readonly __adapter: TAdapter | undefined;
}

/**
 * Output of a public entity exposure decision. Only valid input to
 * `Matches.publicEntities(...)`. Raw entity modules are deliberately rejected at the
 * type level: publishing an entity must be an explicit decision paired with an
 * exposure mode (`readonly`, `as`, or `unsafeFullAdapter`).
 */
export interface PublicEntityCandidate<TContract extends string = string, TAdapter = unknown> {
  /** Internal discriminator that distinguishes candidates from raw entity modules. */
  readonly kind: 'public-entity-candidate';
  /** Owning contract name. */
  readonly contract: TContract;
  /** Registered entity name carried over from the source module. */
  readonly entityName: string;
  /** Exposure metadata captured at publication time. */
  readonly exposure: PublicEntityExposureMetadata;
  /** Source location (`file:line:col`) where the exposure decision was authored. */
  readonly source?: string;
  /** Phantom generic marker so the narrowed adapter shape flows through IntelliSense. */
  readonly __adapter: TAdapter | undefined;
}

/** Minimal entity module contract shared between `slingshot-core` and `slingshot-entity`. */
export interface SlingshotPackageEntityModuleLike<
  TAdapter = unknown,
  TMwName extends string = string,
> {
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
  /** Phantom marker carrying the entity's declared middleware-name union for `definePackage`. */
  readonly __mwNames?: TMwName;
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

/** Single published entity record carried by a contract metadata snapshot. */
export interface PublishedEntityRecord {
  readonly entityName: string;
  readonly source?: string;
  /** Exposure decision recorded at publication. Tooling can use this to scope generated clients. */
  readonly exposure?: PublicEntityExposureMetadata;
}

/** Single published capability record carried by a contract metadata snapshot. */
export interface PublishedCapabilityRecord {
  readonly capabilityName: string;
  readonly source?: string;
}

/**
 * Snapshot of contract metadata attached to packages produced by `Matches.definePackage(...)`.
 * Boot validation reads these to verify cross-package wiring.
 */
export interface PackageContractMetadata {
  /** Contract/package name. */
  readonly name: string;
  /** Source location where the contract was declared, when available. */
  readonly source?: string;
  /** Entity records published as public refs through this contract. */
  readonly publishedEntities: readonly PublishedEntityRecord[];
  /** Capability records declared by this contract. */
  readonly publishedCapabilities: readonly PublishedCapabilityRecord[];
}

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
  /** Contract metadata when the package was produced through `definePackageContract`. */
  readonly contract?: PackageContractMetadata;
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
  /**
   * Contract metadata, populated automatically when the package is produced through
   * `definePackageContract`. Direct callers of `definePackage` should leave this
   * undefined.
   */
  readonly contract?: PackageContractMetadata;
}

type AdapterOf<TModule extends SlingshotPackageEntityModuleLike<unknown>> = Exclude<
  TModule['__adapter'],
  undefined
>;

type ReadonlyAdapterView<TAdapter, TKey extends keyof TAdapter> = {
  readonly [P in TKey]-?: TAdapter[P];
};

type StrictSubsetCheck<TShape, TBase> = {
  [K in keyof TShape]: K extends keyof TBase
    ? TShape[K] extends TBase[K]
      ? TShape[K]
      : never
    : never;
};

/**
 * Fluent builder returned by `contract.publicEntity(module)`. Consumers must pick an
 * exposure mode — `readonly([...])`, `as<TShape>()`, or `unsafeFullAdapter()` — before
 * the candidate can be passed to `contract.publicEntities({...})`.
 */
export interface PublicEntityBuilder<
  TContract extends string,
  TModule extends SlingshotPackageEntityModuleLike<unknown>,
> {
  /** Owning contract name (matches the contract that produced this builder). */
  readonly contract: TContract;
  /** Registered entity name carried over from the source module. */
  readonly entityName: string;
  /**
   * Narrow the public surface to the named methods. Each picked method becomes
   * non-optional in the resulting adapter type — declaring a method publicly
   * asserts it must be present at runtime.
   */
  readonly<TKey extends keyof AdapterOf<TModule> & string>(
    methods: readonly TKey[],
  ): PublicEntityCandidate<TContract, ReadonlyAdapterView<AdapterOf<TModule>, TKey>>;
  /**
   * Declare a custom public adapter shape. The shape must be a structural subset of
   * the underlying adapter — every key must exist on the adapter and every value
   * type must be assignable to the corresponding adapter slot. Excess keys produce
   * a `never` return.
   */
  as<TShape>(): TShape extends StrictSubsetCheck<TShape, AdapterOf<TModule>>
    ? PublicEntityCandidate<TContract, TShape>
    : never;
  /**
   * Expose the full underlying adapter without narrowing. Intentionally verbose —
   * full CRUD exposure should feel exceptional. Prefer `readonly([...])` or `as<T>()`.
   */
  unsafeFullAdapter(): PublicEntityCandidate<TContract, AdapterOf<TModule>>;
}

/**
 * Input contract for `Matches.definePackage(...)`. The contract supplies the package
 * name and accepts contract objects in `dependencies`; everything else mirrors the
 * module-level `DefinePackageInput`.
 */
export type ContractDefinePackageInput = Omit<DefinePackageInput, 'name' | 'dependencies'> & {
  /**
   * Other package contracts or framework plugins/packages that must be installed before this one.
   *
   * Package contracts are normalized to their contract names. String dependencies remain valid
   * for framework-level plugins such as `slingshot-auth` that are not package contracts.
   */
  readonly dependencies?: readonly (PackageContract<string> | string)[];
};

/**
 * Provider-owned package public contract. Binds capabilities and public entity refs to
 * a single package, validates capability ownership at `definePackage(...)` time, and
 * carries identity metadata on every ref/capability it produces so the framework can
 * validate the cross-package graph at boot.
 */
export interface PackageContract<TName extends string = string> {
  /** Internal discriminator for contract objects. */
  readonly kind: 'package-contract';
  /** Stable contract/package name. */
  readonly name: TName;
  /**
   * Begin a public entity exposure decision. The returned builder must be narrowed via
   * `readonly([...])`, `as<T>()`, or `unsafeFullAdapter()` before it can be passed to
   * `publicEntities({...})`.
   */
  publicEntity<TModule extends SlingshotPackageEntityModuleLike<unknown>>(
    module: TModule,
  ): PublicEntityBuilder<TName, TModule>;
  /**
   * Publish a typed map of public entity refs. Accepts only `PublicEntityCandidate`
   * outputs from this contract — raw entity modules and candidates from other
   * contracts are rejected at the type level.
   */
  publicEntities<TMap extends Readonly<Record<string, PublicEntityCandidate<TName, unknown>>>>(
    map: TMap,
  ): {
    readonly [K in keyof TMap]: TMap[K] extends PublicEntityCandidate<TName, infer TAdapter>
      ? PackageEntityRef<TAdapter>
      : never;
  };
  /** Declare a typed capability owned by this contract. */
  capability<TValue>(name: string): PackageCapabilityHandle<TValue>;
  /**
   * Define the package owned by this contract. The package name is taken from the
   * contract; capabilities provided here must belong to this contract; dependencies
   * are supplied as contract objects rather than name strings.
   */
  definePackage(input: ContractDefinePackageInput): SlingshotPackageDefinition;
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
  /**
   * Contract metadata snapshot when the package was produced through `definePackageContract`.
   * Tooling consumers (codegen, OpenAPI client builders, doc generators) read this to
   * narrow public surfaces, list contract-published capabilities, and skip private internals.
   */
  readonly contract?: {
    readonly name: string;
    readonly source?: string;
    readonly publishedEntities: ReadonlyArray<{
      readonly entityName: string;
      readonly source?: string;
      readonly exposure?: PublicEntityExposureMetadata;
    }>;
    readonly publishedCapabilities: ReadonlyArray<{
      readonly capabilityName: string;
      readonly source?: string;
    }>;
  };
}

/**
 * Capture the user-code call site that triggered a contract authoring helper. Skips
 * frames inside `packageAuthoring.ts` (slingshot-core and the framework variant) so
 * the returned location lands on the caller, not on framework internals. Returns
 * `undefined` when the platform doesn't expose a stack — callers should treat it
 * as best-effort metadata.
 */
function captureCallerSite(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  const lines = stack.split('\n').slice(1);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/packageAuthoring\.[tj]s/.test(line)) continue;
    if (/captureCallerSite/.test(line)) continue;
    const parenMatch = line.match(/\(([^)]+)\)\s*$/);
    if (parenMatch) return parenMatch[1];
    const directMatch = line.match(/^at\s+(.+)$/);
    if (directMatch) return directMatch[1];
  }
  return undefined;
}

/**
 * Apply a public entity exposure to an underlying adapter. For `readonly` mode the
 * adapter is wrapped to expose only the declared methods (with `this` rebound on
 * function values). `as` and `unsafeFullAdapter` modes are type-only — the original
 * adapter is returned unchanged. Throws when a declared method is missing on the
 * underlying adapter so contract authors learn about drift fast.
 */
export function applyPublicEntityExposure<TValue>(
  adapter: TValue,
  exposure: PublicEntityExposureMetadata | undefined,
  context: { readonly entity: string; readonly contract?: string; readonly source?: string },
): TValue {
  if (!exposure || !exposure.runtimeEnforced) return adapter;
  if (exposure.mode !== 'readonly') return adapter;
  const methods = exposure.methods;
  if (!methods || methods.length === 0) return adapter;
  if (typeof adapter !== 'object' || adapter === null) return adapter;

  const adapterRecord = adapter as Record<string, unknown>;
  const restricted: Record<string, unknown> = {};
  for (const method of methods) {
    const value = adapterRecord[method];
    if (value === undefined) {
      const where = context.source ? ` (declared at ${context.source})` : '';
      const owner = context.contract ? `contract '${context.contract}' ` : '';
      throw new Error(
        `${owner}public adapter for entity '${context.entity}' declares method '${method}' but the underlying adapter does not implement it${where}`,
      );
    }
    restricted[method] = typeof value === 'function' ? value.bind(adapter) : value;
  }
  return Object.freeze(restricted) as TValue;
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
/**
 * Create a typed entity ref directly from a package/entity name pair.
 *
 * @deprecated For cross-package entity access, prefer publishing a typed ref through a
 *   package contract: `Matches.publicEntities({ Match: Matches.publicEntity(matchModule).readonly([...]) })`.
 *   Contract refs carry exposure metadata, are validated at boot, and produce a narrowed
 *   adapter at lookup time. The string-based form bypasses all of that and is retained
 *   only for legacy / true-escape-hatch code where the entity module isn't importable.
 */
export function entityRef<TAdapter = PackageEntityAdapter>(args: {
  entity: string;
  plugin?: string;
}): PackageEntityRef<TAdapter>;
export function entityRef<TAdapter = PackageEntityAdapter>(
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
  warnLegacyEntityRefOnce(args);
  return Object.freeze({
    kind: 'entity-ref' as const,
    plugin: args.plugin,
    entity: args.entity,
    __adapter: undefined,
  }) as PackageEntityRef<TAdapter>;
}

const warnedLegacyEntityRef = new Set<string>();
function warnLegacyEntityRefOnce(args: { entity: string; plugin?: string }): void {
  const key = `${args.plugin ?? '*'}:${args.entity}`;
  if (warnedLegacyEntityRef.has(key)) return;
  warnedLegacyEntityRef.add(key);
  if (process.env.SLINGSHOT_SUPPRESS_LEGACY_ENTITY_REF_WARNING === '1') return;
  // eslint-disable-next-line no-console
  console.warn(
    `[slingshot] entityRef({ plugin: '${args.plugin ?? '?'}', entity: '${args.entity}' }) is deprecated for cross-package access. ` +
      `Publish a typed ref through a package contract (definePackageContract) and import it from the provider's public.ts. ` +
      `Set SLINGSHOT_SUPPRESS_LEGACY_ENTITY_REF_WARNING=1 to silence.`,
  );
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
  get<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
    config: Omit<
      DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>,
      'kind' | 'method'
    >,
  ): DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>;
  post<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
    config: Omit<
      DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>,
      'kind' | 'method'
    >,
  ): DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>;
  put<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
    config: Omit<
      DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>,
      'kind' | 'method'
    >,
  ): DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>;
  patch<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
    config: Omit<
      DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>,
      'kind' | 'method'
    >,
  ): DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>;
  delete<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
    config: Omit<
      DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>,
      'kind' | 'method'
    >,
  ): DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>;
  head<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
    config: Omit<
      DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>,
      'kind' | 'method'
    >,
  ): DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>;
};

function createRouteBuilder(): PackageRouteBuilder {
  return {
    /** Declare a package-owned `GET` route. */
    get<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
      config: Omit<
        DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>,
        'kind' | 'method'
      >,
    ) {
      return defineDomainRoute<PackageDomainRouteContext<TRequest>, TRequest>('get', config);
    },
    /** Declare a package-owned `POST` route. */
    post<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
      config: Omit<
        DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>,
        'kind' | 'method'
      >,
    ) {
      return defineDomainRoute<PackageDomainRouteContext<TRequest>, TRequest>('post', config);
    },
    /** Declare a package-owned `PUT` route. */
    put<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
      config: Omit<
        DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>,
        'kind' | 'method'
      >,
    ) {
      return defineDomainRoute<PackageDomainRouteContext<TRequest>, TRequest>('put', config);
    },
    /** Declare a package-owned `PATCH` route. */
    patch<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
      config: Omit<
        DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>,
        'kind' | 'method'
      >,
    ) {
      return defineDomainRoute<PackageDomainRouteContext<TRequest>, TRequest>('patch', config);
    },
    /** Declare a package-owned `DELETE` route. */
    delete<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
      config: Omit<
        DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>,
        'kind' | 'method'
      >,
    ) {
      return defineDomainRoute<PackageDomainRouteContext<TRequest>, TRequest>('delete', config);
    },
    /** Declare a package-owned `HEAD` route. */
    head<const TRequest extends TypedRouteRequestSpec = TypedRouteRequestSpec>(
      config: Omit<
        DomainRouteDefinition<PackageDomainRouteContext<TRequest>, TRequest>,
        'kind' | 'method'
      >,
    ) {
      return defineDomainRoute<PackageDomainRouteContext<TRequest>, TRequest>('head', config);
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

/**
 * Internal pluginState key prefix under which package-provided capabilities are stored.
 * Each providing package keeps its `{ [capabilityName]: resolvedValue }` map under
 * `pluginState.get(`${PACKAGE_CAPABILITIES_PREFIX}${pkg.name}`)`. Out-of-request hook
 * callers resolve capabilities by looking up the providing package via
 * `SlingshotContext.capabilityProviders` and reading from this slot.
 *
 * Exported as a stable internal contract so `buildHookServices()` and the framework
 * package compiler stay aligned. Treat as framework-internal — consumer code should
 * use `ctx.capabilities.maybe()` (request handlers) or `services.capabilities.maybe()`
 * (out-of-request hooks) instead.
 */
export const PACKAGE_CAPABILITIES_PREFIX = 'slingshot:package:capabilities:';

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
    contract: input.contract,
  });
}

/**
 * Internal factory for the fluent public-entity builder. The returned object is cast
 * to `PublicEntityBuilder` at the boundary; consumers see the typed interface (with
 * full JSDoc) at every call site.
 */
function createPublicEntityBuilder<
  TContract extends string,
  TModule extends SlingshotPackageEntityModuleLike<unknown>,
>(contract: TContract, module: TModule): PublicEntityBuilder<TContract, TModule> {
  const entityName = module.entityName;
  const builder = {
    contract,
    entityName,
    /** Implements `PublicEntityBuilder.readonly` — narrows to the named methods with runtime enforcement. */
    readonly(methods: readonly string[]) {
      const source = captureCallerSite();
      return Object.freeze({
        kind: 'public-entity-candidate' as const,
        contract,
        entityName,
        exposure: Object.freeze({
          mode: 'readonly' as const,
          methods: Object.freeze([...methods]),
          runtimeEnforced: true,
        }),
        source,
        __adapter: undefined,
      });
    },
    /** Implements `PublicEntityBuilder.as` — type-only narrowing, no runtime enforcement. */
    as() {
      const source = captureCallerSite();
      return Object.freeze({
        kind: 'public-entity-candidate' as const,
        contract,
        entityName,
        exposure: Object.freeze({
          mode: 'as' as const,
          runtimeEnforced: false,
        }),
        source,
        __adapter: undefined,
      });
    },
    /** Implements `PublicEntityBuilder.unsafeFullAdapter` — opts out of narrowing entirely. */
    unsafeFullAdapter() {
      const source = captureCallerSite();
      return Object.freeze({
        kind: 'public-entity-candidate' as const,
        contract,
        entityName,
        exposure: Object.freeze({
          mode: 'unsafeFullAdapter' as const,
          runtimeEnforced: false,
        }),
        source,
        __adapter: undefined,
      });
    },
  };
  return Object.freeze(builder) as unknown as PublicEntityBuilder<TContract, TModule>;
}

/**
 * Declare a provider-owned package public contract. The returned object owns the
 * package's typed public surface — capabilities and public entity refs — and gates
 * `definePackage(...)` so capability ownership and dependency wiring can be validated
 * at authoring time.
 */
export function definePackageContract<const TName extends string>(
  contractName: TName,
): PackageContract<TName> {
  const contractSource = captureCallerSite();
  const publishedEntities = new Map<string, PublishedEntityRecord>();
  const publishedCapabilities = new Map<string, PublishedCapabilityRecord>();

  const contract: PackageContract<TName> = Object.freeze({
    kind: 'package-contract' as const,
    name: contractName,
    /** Implements `PackageContract.publicEntity` — produces a fluent exposure builder. */
    publicEntity<TModule extends SlingshotPackageEntityModuleLike<unknown>>(module: TModule) {
      return createPublicEntityBuilder<TName, TModule>(contractName, module);
    },
    /** Implements `PackageContract.publicEntities` — turns candidates into refs and remembers them for boot validation. */
    publicEntities<TMap extends Readonly<Record<string, PublicEntityCandidate<TName, unknown>>>>(
      map: TMap,
    ) {
      const entries = Object.entries(map).map(([key, candidate]) => {
        const ref: PackageEntityRef = Object.freeze({
          kind: 'entity-ref' as const,
          plugin: candidate.contract,
          entity: candidate.entityName,
          contract: candidate.contract,
          exposure: candidate.exposure,
          source: candidate.source,
          __adapter: undefined,
        });
        if (!publishedEntities.has(candidate.entityName)) {
          publishedEntities.set(
            candidate.entityName,
            Object.freeze({
              entityName: candidate.entityName,
              source: candidate.source,
              exposure: candidate.exposure,
            }),
          );
        }
        return [key, ref] as const;
      });
      return Object.freeze(Object.fromEntries(entries)) as {
        readonly [K in keyof TMap]: TMap[K] extends PublicEntityCandidate<TName, infer TAdapter>
          ? PackageEntityRef<TAdapter>
          : never;
      };
    },
    /** Implements `PackageContract.capability` — stamps contract identity and remembers the declaration for boot validation. */
    capability<TValue>(capabilityName: string) {
      const source = captureCallerSite();
      if (!publishedCapabilities.has(capabilityName)) {
        publishedCapabilities.set(capabilityName, Object.freeze({ capabilityName, source }));
      }
      return Object.freeze({
        kind: 'capability' as const,
        name: capabilityName,
        contract: contractName,
        source,
        __value: undefined,
      }) as PackageCapabilityHandle<TValue>;
    },
    /** Implements `PackageContract.definePackage` — name-injection, capability/entity validation, contract metadata snapshot. */
    definePackage(input: ContractDefinePackageInput): SlingshotPackageDefinition {
      const provided = input.capabilities?.provides;
      if (provided) {
        for (const entry of provided) {
          const owner = entry.capability.contract;
          if (owner && owner !== contractName) {
            const where = entry.capability.source
              ? ` (declared at ${entry.capability.source})`
              : '';
            throw new Error(
              `Package contract "${contractName}" cannot provide capability "${entry.capability.name}" because it is owned by contract "${owner}"${where}.`,
            );
          }
        }
      }
      const registeredEntityNames = new Set(
        (input.entities ?? []).map(entityModule => entityModule.entityName),
      );
      for (const record of publishedEntities.values()) {
        if (!registeredEntityNames.has(record.entityName)) {
          const where = record.source ? ` (published at ${record.source})` : '';
          throw new Error(
            `Package contract "${contractName}" publishes entity "${record.entityName}" but the package does not register it${where}. Add it to definePackage({ entities: [...] }).`,
          );
        }
      }
      const dependencyNames = input.dependencies?.map(dep =>
        typeof dep === 'string' ? dep : dep.name,
      );
      const { dependencies: _ignored, ...rest } = input;
      return definePackage({
        ...rest,
        name: contractName,
        dependencies: dependencyNames,
        contract: Object.freeze({
          name: contractName,
          source: contractSource,
          publishedEntities: Object.freeze([...publishedEntities.values()]),
          publishedCapabilities: Object.freeze([...publishedCapabilities.values()]),
        }),
      });
    },
  });
  return contract;
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
    contract: pkg.contract
      ? Object.freeze({
          name: pkg.contract.name,
          source: pkg.contract.source,
          publishedEntities: Object.freeze(
            pkg.contract.publishedEntities.map(record =>
              Object.freeze({
                entityName: record.entityName,
                source: record.source,
                exposure: record.exposure,
              }),
            ),
          ),
          publishedCapabilities: Object.freeze(
            pkg.contract.publishedCapabilities.map(record =>
              Object.freeze({
                capabilityName: record.capabilityName,
                source: record.source,
              }),
            ),
          ),
        })
      : undefined,
  });
}
