import type {
  OperationConfig,
  RepoFactories,
  ResolvedEntityConfig,
  SearchClientLike,
  StoreInfra,
} from '@lastshotlabs/slingshot-core';
import {
  RESOLVE_COMPOSITE_FACTORIES,
  RESOLVE_ENTITY_FACTORIES,
  RESOLVE_REINDEX_SOURCE,
} from '@lastshotlabs/slingshot-core';

/**
 * Well-known Reflect symbol used to inject the entity registration hook onto a
 * `FrameworkStoreInfra`. When called, implementations should register the
 * entity config in the app's `EntityRegistry` and trigger any necessary search
 * index initialization.
 */
export const REGISTER_ENTITY = Symbol.for('slingshot.registerEntity');

/**
 * Well-known Reflect symbol used to inject the search-sync resolver onto a
 * `FrameworkStoreInfra`. When called, implementations return a
 * `ResolvedSearchSync` descriptor that drives the `wrapWithSearchSync`
 * decorator, or `undefined` when the entity has no search config.
 */
export const RESOLVE_SEARCH_SYNC = Symbol.for('slingshot.resolveSearchSync');

/**
 * Well-known Reflect symbol used to inject the search-client resolver onto a
 * `FrameworkStoreInfra`. When called, implementations return the live
 * `SearchClientLike` for the entity's storage name, or `null` when the search
 * plugin is absent or not yet ready.
 */
export const RESOLVE_SEARCH_CLIENT = Symbol.for('slingshot.resolveSearchClient');

/**
 * Well-known Reflect symbol used to attach the `FrameworkStoreInfra` instance
 * to a `SlingshotContext` carrier object. The property is non-enumerable and
 * non-writable; retrieval is via `getContextStoreInfra()`.
 */
export const CONTEXT_STORE_INFRA = Symbol.for('slingshot.contextStoreInfra');
const FRAMEWORK_STORE_INFRA_BRAND = new WeakSet<object>();

/**
 * Minimal event-bus interface used by `EventBusSearchSync` to avoid a hard
 * dependency on `SlingshotEventBus`. Allows search-sync to emit entity events
 * without importing the full event-bus type.
 */
export interface DynamicEntityEventBus {
  emit(event: string, payload: unknown): void;
}

/**
 * Search sync descriptor for `syncMode: 'manual'`.
 *
 * No automatic sync is performed after mutations. The application is
 * responsible for indexing documents at the right time. `ensureReady` is a
 * no-op and always resolves immediately.
 */
export interface ManualSearchSync {
  readonly syncMode: 'manual';
  ensureReady(): Promise<void>;
}

/**
 * Search sync descriptor for `syncMode: 'event-bus'`.
 *
 * After each mutation the adapter emits an `entity:<storageName>.created|updated|deleted`
 * event on the provided `eventBus`. A subscriber (typically the search plugin)
 * is expected to pick up the event and update the search index asynchronously.
 */
export interface EventBusSearchSync {
  readonly syncMode: 'event-bus';
  readonly storageName: string;
  readonly eventBus: DynamicEntityEventBus;
  ensureReady(): Promise<void>;
}

/**
 * Search sync descriptor for `syncMode: 'write-through'` (the default).
 *
 * After each mutation the adapter directly calls `indexDocument` or
 * `deleteDocument` on the search client, keeping the search index consistent
 * with the primary store on every write.
 */
export interface WriteThroughSearchSync {
  readonly syncMode: 'write-through';
  ensureReady(): Promise<void>;
  indexDocument(entity: Record<string, unknown>): Promise<void>;
  deleteDocument(id: string): Promise<void>;
}

/**
 * Discriminated union of all supported search sync strategies.
 * Narrowed by the `syncMode` discriminant field.
 */
export type ResolvedSearchSync = ManualSearchSync | EventBusSearchSync | WriteThroughSearchSync;

/**
 * Optional Reflect symbol hooks that extend `StoreInfra` with framework-level
 * DI capabilities. Implementations attach concrete logic for entity registration
 * and search sync resolution.
 */
export interface FrameworkRepoResolutionHooks {
  [REGISTER_ENTITY]?(config: ResolvedEntityConfig): void;
  [RESOLVE_SEARCH_SYNC]?(config: ResolvedEntityConfig): ResolvedSearchSync | undefined;
  [RESOLVE_SEARCH_CLIENT]?(config: ResolvedEntityConfig): SearchClientLike | null;
  [RESOLVE_REINDEX_SOURCE]?(
    entityStorageName: string,
  ): AsyncIterable<Record<string, unknown>> | null;
  [RESOLVE_ENTITY_FACTORIES]?(
    config: ResolvedEntityConfig,
    operations?: Record<string, OperationConfig>,
  ): RepoFactories<Record<string, unknown>>;
  [RESOLVE_COMPOSITE_FACTORIES]?(
    entities: Record<
      string,
      { config: ResolvedEntityConfig; operations: Record<string, OperationConfig> }
    >,
    operations?: Record<string, OperationConfig>,
  ): RepoFactories<Record<string, unknown>>;
}

/**
 * The concrete `StoreInfra` implementation used inside a `SlingshotContext`.
 * Extends `StoreInfra` with the three framework DI hooks defined above.
 */
export type FrameworkStoreInfra = StoreInfra & FrameworkRepoResolutionHooks;

interface FrameworkStoreInfraCarrier {
  [CONTEXT_STORE_INFRA]?: FrameworkStoreInfra;
}

function isFrameworkStoreInfra(value: object): value is FrameworkStoreInfra {
  return FRAMEWORK_STORE_INFRA_BRAND.has(value);
}

/**
 * Attach a `FrameworkStoreInfra` to an arbitrary carrier object using the
 * `CONTEXT_STORE_INFRA` Symbol as a non-enumerable, non-writable property.
 *
 * Typically called once during `SlingshotContext` construction. The property is
 * non-configurable so it cannot be replaced after attachment.
 *
 * @param target - The object to attach the infra to (e.g. `SlingshotContext`).
 * @param storeInfra - The `FrameworkStoreInfra` instance to attach.
 */
export function attachContextStoreInfra(target: object, storeInfra: FrameworkStoreInfra): void {
  FRAMEWORK_STORE_INFRA_BRAND.add(storeInfra);
  Object.defineProperty(target, CONTEXT_STORE_INFRA, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: storeInfra,
  });
}

/**
 * Retrieve the `FrameworkStoreInfra` previously attached to a carrier object
 * via `attachContextStoreInfra`.
 *
 * @param target - The carrier object to read from.
 * @returns The attached `FrameworkStoreInfra`, or `null` if none was attached.
 */
export function getContextStoreInfra(target: object): FrameworkStoreInfra | null {
  const storeInfra = (target as FrameworkStoreInfraCarrier)[CONTEXT_STORE_INFRA] ?? null;
  if (!storeInfra || !isFrameworkStoreInfra(storeInfra)) return null;
  return storeInfra;
}
