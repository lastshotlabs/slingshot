import type {
  EntityAdapter,
  EntityChannelConfig,
  FieldDef,
  InferCreateInput,
  InferEntity,
  InferOperationMethods,
  InferUpdateInput,
  OperationConfig,
  RepoFactories,
  ResolvedEntityConfig,
  SlingshotPackageEntityModuleLike,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import type { BareEntityAdapter } from './routing/buildBareEntityRoutes';
import type { EntityExtraRoute, EntityRouteExecutorOverrides } from './routing/entityRoutePlanning';
import type { ResolvedOperations } from './types';

/** Use the framework's default adapter resolution for the entity. */
export interface StandardEntityModuleWiring {
  /** Defaults to `standard` when omitted. */
  readonly mode?: 'standard';
}

/** Resolve the entity adapter from repo factories instead of the default registry path. */
export interface FactoriesEntityModuleWiring {
  /** Factory-backed adapter wiring mode. */
  readonly mode: 'factories';
  /** Repo factory set used to build the adapter for the active store. */
  readonly factories: RepoFactories<BareEntityAdapter | Record<string, unknown>>;
  /** Optional entity key override used when a factory bundle exposes multiple entities. */
  readonly entityKey?: string;
  /** Optional callback invoked with the resolved adapter after bootstrap. */
  readonly onAdapter?: (adapter: BareEntityAdapter) => void;
}

/** Fully manual adapter construction for advanced authoring cases. */
export interface ManualEntityModuleWiring {
  /** Manual adapter wiring mode. */
  readonly mode: 'manual';
  /** Adapter builder invoked with the active store type and infra bundle. */
  readonly buildAdapter: (storeType: StoreType, infra: StoreInfra) => BareEntityAdapter;
}

/** Supported adapter-wiring strategies for a package-owned entity module. */
export type EntityModuleWiring =
  | StandardEntityModuleWiring
  | FactoriesEntityModuleWiring
  | ManualEntityModuleWiring;

type NormalizeOperationsInput<TOperations extends EntityOperationsInput> =
  TOperations extends ResolvedOperations<infer TOps>
    ? TOps
    : TOperations extends Record<string, OperationConfig>
      ? TOperations
      : undefined;

/** Strongly typed adapter surface inferred from an entity config and optional operation map. */
export type PackageEntityAdapterFor<
  TConfig extends ResolvedEntityConfig = ResolvedEntityConfig,
  TOperations extends Record<string, OperationConfig> | undefined = undefined,
> = EntityAdapter<
  InferEntity<TConfig['fields']>,
  InferCreateInput<TConfig['fields']>,
  InferUpdateInput<TConfig['fields']>
> &
  (TOperations extends Record<string, OperationConfig>
    ? InferOperationMethods<TOperations, InferEntity<TConfig['fields']>>
    : Record<string, never>);

/** Normalized entity module implementation compiled into the framework plugin lifecycle. */
export interface PackageEntityModuleImplementation {
  /** Resolved entity config used for route generation and adapter registration. */
  readonly config: ResolvedEntityConfig;
  /** Named operations exposed on the generated adapter and route surface. */
  readonly operations?: Record<string, OperationConfig>;
  /** Extra routes mounted inside the managed entity shell. */
  readonly extraRoutes?: readonly EntityExtraRoute[];
  /** Generated-route executor overrides. */
  readonly overrides?: EntityRouteExecutorOverrides;
  /** Realtime channel declarations owned by the entity. */
  readonly channels?: EntityChannelConfig;
  /** Explicit route path override relative to the package mount path. */
  readonly routePath?: string;
  /** Optional parent path prefix for nested entity routes. */
  readonly parentPath?: string;
  /** Adapter wiring strategy for this entity module. */
  readonly wiring: EntityModuleWiring;
}

/** Package-owned entity module returned by `entity(...)`. */
export interface PackageEntityModule<
  TAdapter = unknown,
  TMwName extends string = string,
> extends SlingshotPackageEntityModuleLike<TAdapter, TMwName> {
  /** `slingshot-entity` implementation details consumed by the runtime compiler. */
  readonly implementation: PackageEntityModuleImplementation;
}

/**
 * Extract the middleware-name union from a {@link ResolvedEntityConfig}'s second generic.
 */
type EntityMiddlewareNamesOf<TConfig> = TConfig extends ResolvedEntityConfig<
  Record<string, FieldDef>,
  infer TMwName
>
  ? TMwName
  : never;

type EntityOperationsInput =
  | Record<string, OperationConfig>
  | ResolvedOperations<Record<string, OperationConfig>>
  | undefined;

function isResolvedOperations(
  operations: Record<string, OperationConfig> | ResolvedOperations<Record<string, OperationConfig>>,
): operations is ResolvedOperations<Record<string, OperationConfig>> {
  return (
    'entityConfig' in operations &&
    'operations' in operations &&
    typeof operations.operations === 'object' &&
    operations.operations !== null
  );
}

function normalizeOperations(
  operations: EntityOperationsInput,
): Record<string, OperationConfig> | undefined {
  if (!operations) return undefined;
  return isResolvedOperations(operations) ? operations.operations : operations;
}

function freezeRecord<TValue extends object>(value: TValue | undefined): TValue | undefined {
  if (!value) return undefined;
  return Object.freeze({ ...value }) as TValue;
}

function freezeArray<TValue>(value: readonly TValue[] | undefined): readonly TValue[] | undefined {
  if (!value) return undefined;
  return Object.freeze([...value]);
}

/**
 * Declare a package-owned entity module.
 *
 * Standard wiring is the default and should cover the normal case where the framework can
 * resolve the adapter from the entity config and active persistence backend.
 */
export function entity<
  const TConfig extends ResolvedEntityConfig,
  const TOperations extends EntityOperationsInput = undefined,
>(config: {
  /** Resolved entity config to mount. */
  readonly config: TConfig;
  /** Operation map or `defineOperations(...)` result used for generated routes. */
  readonly operations?: TOperations;
  /** Additional custom routes mounted inside the entity route shell. */
  readonly extraRoutes?: readonly EntityExtraRoute[];
  /** Generated-route executor overrides. */
  readonly overrides?: EntityRouteExecutorOverrides;
  /** Optional realtime channel declarations. */
  readonly channels?: EntityChannelConfig;
  /** Optional route path override relative to the package mount path. */
  readonly path?: string;
  /** Optional parent path prefix for nested entity routes. */
  readonly parentPath?: string;
  /** Adapter wiring override. Defaults to `{ mode: 'standard' }`. */
  readonly wiring?: EntityModuleWiring;
}): PackageEntityModule<
  PackageEntityAdapterFor<TConfig, NormalizeOperationsInput<TOperations>>,
  EntityMiddlewareNamesOf<TConfig>
>;
export function entity(config: {
  readonly config: ResolvedEntityConfig;
  readonly operations?: EntityOperationsInput;
  readonly extraRoutes?: readonly EntityExtraRoute[];
  readonly overrides?: EntityRouteExecutorOverrides;
  readonly channels?: EntityChannelConfig;
  readonly path?: string;
  readonly parentPath?: string;
  readonly wiring?: EntityModuleWiring;
}): PackageEntityModule {
  const operations = normalizeOperations(config.operations);
  return Object.freeze({
    kind: 'entity' as const,
    name: config.config.name,
    entityName: config.config.name,
    path: config.path,
    __adapter: undefined,
    implementation: Object.freeze({
      config: config.config,
      operations,
      extraRoutes: freezeArray(config.extraRoutes),
      overrides: freezeRecord(config.overrides),
      channels: config.channels,
      routePath: config.path,
      parentPath: config.parentPath,
      wiring: Object.freeze({ ...(config.wiring ?? { mode: 'standard' }) }),
    }),
  });
}
