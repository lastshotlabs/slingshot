/**
 * Shared entity-backend capability contracts.
 *
 * Capability IDs are consumed by runtime startup validation, the entity
 * conformance suite, generated support documentation, and CI evidence.
 */
import { ENTITY_OPERATION_KINDS } from './operations';
import type { OperationConfig } from './operations';
import type { StoreType } from './storeType';

/** Every declarative entity operation discriminant. */
export type EntityOperationKind = OperationConfig['kind'];

/**
 * Stable semantic capability identifiers for standard entity adapters.
 *
 * Operation availability and concurrency guarantees are separate on purpose:
 * an adapter may expose an operation executor without being able to provide an
 * atomic implementation of that operation.
 */
export type EntityBackendCapability =
  | 'crud.create'
  | 'crud.read'
  | 'crud.update'
  | 'crud.delete'
  | 'crud.list'
  | 'crud.clear'
  | 'defaults.apply'
  | 'mapping.fields'
  | 'constraint.unique'
  | 'scope.tenant'
  | 'lifecycle.soft-delete'
  | 'lifecycle.ttl-visibility'
  | 'query.sort'
  | 'query.cursor'
  | 'filter.eq'
  | 'filter.ne'
  | 'filter.gt'
  | 'filter.gte'
  | 'filter.lt'
  | 'filter.lte'
  | 'filter.in'
  | 'filter.nin'
  | 'filter.contains'
  | 'filter.and'
  | 'filter.or'
  | `operation.${EntityOperationKind}`
  | 'atomic.transition'
  | 'atomic.increment'
  | 'atomic.array-mutation'
  | 'atomic.consume'
  | 'atomic.upsert'
  | 'atomic.batch'
  | 'atomic.computed-aggregate'
  | 'transaction.rollback';

/**
 * Runtime-complete capability ordering used by profiles, reports, and docs.
 */
export const ENTITY_BACKEND_CAPABILITIES = [
  'crud.create',
  'crud.read',
  'crud.update',
  'crud.delete',
  'crud.list',
  'crud.clear',
  'defaults.apply',
  'mapping.fields',
  'constraint.unique',
  'scope.tenant',
  'lifecycle.soft-delete',
  'lifecycle.ttl-visibility',
  'query.sort',
  'query.cursor',
  'filter.eq',
  'filter.ne',
  'filter.gt',
  'filter.gte',
  'filter.lt',
  'filter.lte',
  'filter.in',
  'filter.nin',
  'filter.contains',
  'filter.and',
  'filter.or',
  ...ENTITY_OPERATION_KINDS.map(kind => `operation.${kind}` as const),
  'atomic.transition',
  'atomic.increment',
  'atomic.array-mutation',
  'atomic.consume',
  'atomic.upsert',
  'atomic.batch',
  'atomic.computed-aggregate',
  'transaction.rollback',
] as const satisfies readonly EntityBackendCapability[];

type AssertNever<T extends never> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type MissingEntityBackendCapability = AssertNever<
  Exclude<EntityBackendCapability, (typeof ENTITY_BACKEND_CAPABILITIES)[number]>
>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type ExtraEntityBackendCapability = AssertNever<
  Exclude<(typeof ENTITY_BACKEND_CAPABILITIES)[number], EntityBackendCapability>
>;

/** A backend's explicit support status for one semantic capability. */
export type EntityBackendCapabilityClaim =
  | { readonly status: 'supported' }
  | {
      readonly status: 'unsupported';
      /** Human-readable explanation used by startup errors and generated docs. */
      readonly reason: string;
    };

/** Exhaustive semantic profile for one standard entity backend. */
export interface EntityBackendProfile {
  /** Store selected by framework persistence resolution. */
  readonly store: StoreType;
  /** Whether this store is intended for deployed applications rather than tests/development. */
  readonly production: boolean;
  /** One immutable claim for every known capability ID. */
  readonly capabilities: Readonly<Record<EntityBackendCapability, EntityBackendCapabilityClaim>>;
}

/** One semantic capability required by an entity or named operation. */
export interface EntityBackendRequirement {
  /** Capability the selected backend must support. */
  readonly capability: EntityBackendCapability;
  /** Deterministic description of the config surface that requires it. */
  readonly requiredBy: string;
}
