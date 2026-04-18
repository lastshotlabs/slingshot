/**
 * Operations layer — re-exported from @lastshotlabs/slingshot-core.
 *
 * `slingshot-core` is the single source of truth for all operation type definitions.
 * This file re-exports those types and provides two public APIs:
 *
 * - **`op.*` builders** — tagged-union factories that stamp the `kind` discriminant
 *   onto a config object. Each builder corresponds to one operation kind.
 * - **`defineOperations()`** — pairs a set of operation configs with the entity config
 *   they belong to, producing a `ResolvedOperations` object ready for adapter wiring.
 *
 * **Adding a new operation kind:**
 * 1. Define `MyOpConfig` (with `kind: 'myKind'`) in `slingshot-core` and add it to
 *    the `OperationConfig` discriminated union there.
 * 2. Add a builder to the `op` object here: `myKind: (config) => ({ kind: 'myKind', ...config })`.
 * 3. Add a `case 'myKind':` to every backend wiring file:
 *    - `memoryOperationWiring.ts`
 *    - `sqliteOperationWiring.ts`
 *    - `postgresOperationWiring.ts`
 *    - `mongoOperationWiring.ts`
 *    - `redisOperationWiring.ts`
 * 4. Implement the executor in `operationExecutors/myKind.ts` following the
 *    per-backend pattern used by the existing executors.
 */
import type {
  OperationConfig,
  ResolvedEntityConfig,
  ResolvedOperations,
} from '@lastshotlabs/slingshot-core';
// Import specific types needed for the builders
import type {
  AggregateOpConfig,
  ArrayPullOpConfig,
  ArrayPushOpConfig,
  ArraySetOpConfig,
  BatchOpConfig,
  CollectionOpConfig,
  ComputedAggregateOpConfig,
  ConsumeOpConfig,
  CustomOpConfig,
  DeriveOpConfig,
  ExistsOpConfig,
  FieldUpdateOpConfig,
  IncrementOpConfig,
  LookupOpConfig,
  SearchOpConfig,
  TransitionOpConfig,
  UpsertOpConfig,
} from '@lastshotlabs/slingshot-core';

// Re-export all operation types from slingshot-core
export type {
  FilterExpression,
  FilterValue,
  FilterOperator,
  ComputeSpec,
  ComputedField,
  MergeStrategy,
  LookupOpConfig,
  ExistsOpConfig,
  TransitionOpConfig,
  FieldUpdateOpConfig,
  AggregateOpConfig,
  ComputedAggregateOpConfig,
  BatchOpConfig,
  UpsertOpConfig,
  SearchOpConfig,
  CollectionOpConfig,
  CollectionOperation,
  ConsumeOpConfig,
  DeriveOpConfig,
  DeriveSource,
  CustomOpConfig,
  ArrayPushOpConfig,
  ArrayPullOpConfig,
  ArraySetOpConfig,
  IncrementOpConfig,
  OperationConfig,
  ResolvedOperations,
} from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// op.* builder API
// ---------------------------------------------------------------------------

/**
 * Tagged-union factories for every supported operation kind.
 *
 * Each builder accepts a config object _without_ the `kind` discriminant and
 * returns the fully-typed config with `kind` stamped in. Pass the result directly
 * to `defineOperations()`.
 *
 * @example
 * ```ts
 * const ops = defineOperations(User, {
 *   findByEmail: op.lookup({ by: ['email'] }),
 *   activate:    op.transition({ field: 'status', from: 'pending', to: 'active' }),
 *   totalPosts:  op.computedAggregate({ ... }),
 * });
 * ```
 */
export const op = {
  /**
   * Filter-based record retrieval with cursor pagination, sort, and limit support.
   * Maps to `lookupMemory`, `lookupSqlite`, `lookupPostgres`, `lookupMongo`, `lookupRedis`.
   */
  lookup: (config: Omit<LookupOpConfig, 'kind'>): LookupOpConfig => ({ kind: 'lookup', ...config }),
  /**
   * Boolean existence check — returns `true`/`false` without fetching the full record.
   * Maps to `existsMemory`, `existsSqlite`, `existsPostgres`, `existsMongo`, `existsRedis`.
   */
  exists: (config: Omit<ExistsOpConfig, 'kind'>): ExistsOpConfig => ({ kind: 'exists', ...config }),
  /**
   * Atomic field-value state transition (e.g. `'pending' → 'active'`).
   * Validates the current value before writing the next value.
   * Maps to `transitionMemory`, `transitionSqlite`, etc.
   */
  transition: (config: Omit<TransitionOpConfig, 'kind'>): TransitionOpConfig => ({
    kind: 'transition',
    ...config,
  }),
  /**
   * Targeted partial update of specific fields without a full entity replace.
   * Supports array-field mutations via dedicated `arrayPush`/`arrayPull` ops.
   * Maps to `fieldUpdateMemory`, `fieldUpdateSqlite`, etc.
   */
  fieldUpdate: (config: Omit<FieldUpdateOpConfig, 'kind'>): FieldUpdateOpConfig => ({
    kind: 'fieldUpdate',
    ...config,
  }),
  /**
   * Append a value to an array field on a record identified by its primary key.
   * When `dedupe` is true (default), the value is only pushed if not already present.
   * Value binding: `'ctx:key'`, `'param:key'`, `'input:key'`, or a literal.
   * Route: `POST /{entity}/:id/{op-kebab}`
   */
  arrayPush: (config: Omit<ArrayPushOpConfig, 'kind'>): ArrayPushOpConfig => ({
    kind: 'arrayPush',
    ...config,
  }),
  /**
   * Remove all occurrences of a value from an array field on a record identified by its primary key.
   * Value binding: `'ctx:key'`, `'param:key'`, `'input:key'`, or a literal.
   * Route: `DELETE /{entity}/:id/{op-kebab}`
   */
  arrayPull: (config: Omit<ArrayPullOpConfig, 'kind'>): ArrayPullOpConfig => ({
    kind: 'arrayPull',
    ...config,
  }),
  /**
   * Replace the entire contents of an array field on a record identified by its primary key.
   * With `dedupe: true` (the default), the server deduplicates the incoming array before writing.
   * Value binding resolves to the replacement array: `'input:key'` (recommended), `'ctx:key'`, `'param:key'`.
   * Route: `PUT /{entity}/:id/{op-kebab}`
   *
   * @example
   * ```ts
   * op.arraySet({ field: 'labelIds', value: 'input:labelIds' })
   * op.arraySet({ field: 'permissions', value: 'input:permissions', dedupe: false })
   * ```
   */
  arraySet: (config: Omit<ArraySetOpConfig, 'kind'>): ArraySetOpConfig => ({
    kind: 'arraySet',
    ...config,
  }),
  /**
   * Atomically increment (or decrement) a numeric field on a record identified by its
   * primary key. The field value is coerced to `0` when absent or non-numeric before
   * the delta is applied. Pass `by: -1` (or any negative number) to decrement.
   *
   * The `by` value can also be supplied at call time as the second argument to the
   * returned executor function — the call-time value takes precedence over `op.by`.
   * When neither is supplied the default delta is `1`.
   *
   * Maps to `incrementMemory`, `incrementSqlite`, `incrementPostgres`,
   * `incrementMongo`, `incrementRedis`.
   *
   * @example
   * ```ts
   * op.increment({ field: 'viewCount' })           // +1
   * op.increment({ field: 'score', by: 5 })        // +5
   * op.increment({ field: 'balance', by: -10 })    // -10 (decrement)
   * ```
   */
  increment: (config: Omit<IncrementOpConfig, 'kind'>): IncrementOpConfig => ({
    kind: 'increment',
    ...config,
  }),
  /**
   * Read-only aggregation (count, sum, avg, etc.) returned as a plain value.
   * Does not write back to any record. See `computedAggregate` for write-back.
   * Maps to `aggregateMemory`, `aggregateSqlite`, etc.
   */
  aggregate: (config: Omit<AggregateOpConfig, 'kind'>): AggregateOpConfig => ({
    kind: 'aggregate',
    ...config,
  }),
  /**
   * Aggregation that materializes the result into a field on a target record.
   * Finds source records matching `sourceFilter`, computes `compute` specs, then
   * writes the result to `materializeTo` on the record matched by `targetMatch`.
   * Maps to `computedAggregateMemory`, `computedAggregateSqlite`, etc.
   */
  computedAggregate: (
    config: Omit<ComputedAggregateOpConfig, 'kind'>,
  ): ComputedAggregateOpConfig => ({ kind: 'computedAggregate', ...config }),
  /**
   * Multi-record read or write in a single operation (e.g. bulk delete, multi-get).
   * Maps to `batchMemory`, `batchSqlite`, etc.
   */
  batch: (config: Omit<BatchOpConfig, 'kind'>): BatchOpConfig => ({ kind: 'batch', ...config }),
  /**
   * Insert-or-update by a natural key — idempotent create-or-replace.
   * Maps to `upsertMemory`, `upsertSqlite`, etc.
   */
  upsert: (config: Omit<UpsertOpConfig, 'kind'>): UpsertOpConfig => ({ kind: 'upsert', ...config }),
  /**
   * Full-text or keyword search, optionally delegating to an external search provider
   * (e.g. Meilisearch, Typesense) when one is configured on the entity.
   * Maps to `searchMemory`, `searchSqlite`, etc.
   */
  search: (config: Omit<SearchOpConfig, 'kind'>): SearchOpConfig => ({ kind: 'search', ...config }),
  /**
   * Embedded one-to-many collection within a parent record (add, remove, list, set, update).
   * Generates `${opName}List`, `${opName}Add`, `${opName}Remove`, `${opName}Update`,
   * and `${opName}Set` methods on the adapter.
   * Maps to `collectionMemory`, `collectionSqlite`, etc.
   */
  collection: (config: Omit<CollectionOpConfig, 'kind'>): CollectionOpConfig => ({
    kind: 'collection',
    ...config,
  }),
  /**
   * Read-and-delete in one atomic step (queue-style consumption).
   * Maps to `consumeMemory`, `consumeSqlite`, etc.
   */
  consume: (config: Omit<ConsumeOpConfig, 'kind'>): ConsumeOpConfig => ({
    kind: 'consume',
    ...config,
  }),
  /**
   * Derive a computed field value from related records and write it back to the entity.
   * Maps to `deriveMemory`, `deriveSqlite`, etc.
   */
  derive: (config: Omit<DeriveOpConfig, 'kind'>): DeriveOpConfig => ({ kind: 'derive', ...config }),
  /**
   * Escape hatch for backend-specific logic not covered by built-in operation kinds.
   * Provide a factory for each backend you need (`memory`, `sqlite`, `postgres`, `mongo`, `redis`).
   * The factory receives the raw backend handle and returns the operation function.
   *
   * Set `http` to have the entity plugin auto-mount an HTTP route for this operation.
   * The route calls `adapter[opName](body)` — the method must be on the adapter either
   * from a backend factory or mixed in externally (e.g. from a composite adapter).
   * When `http` is omitted, no route is auto-mounted.
   *
   * @example
   * ```ts
   * // Factory-wired with auto-mounted route:
   * op.custom({
   *   http: { method: 'post' },
   *   memory: (store) => (id: string) => store.get(id)?.record ?? null,
   *   sqlite: (db) => (id: string) => db.query('SELECT * FROM items WHERE id = ?').get(id),
   * })
   *
   * // Route-only marker for a method mixed in from a composite adapter:
   * op.custom({ http: { method: 'post' } })
   * ```
   */
  custom: <Fn>(config: Omit<CustomOpConfig<Fn>, 'kind'>): CustomOpConfig<Fn> => ({
    kind: 'custom',
    ...config,
  }),
} as const;

// ---------------------------------------------------------------------------
// defineOperations()
// ---------------------------------------------------------------------------

/**
 * Bind a set of operation configs to an entity config, producing a
 * `ResolvedOperations` object that adapter factories consume.
 *
 * Pass the result to `createEntityFactories()` or `createCompositeFactories()`
 * as the `operations` option to have the operations wired into every backend adapter.
 *
 * @param entityConfig - The resolved entity config (from `defineEntity(...).config`).
 * @param operations   - A map of operation name → operation config built with `op.*` builders.
 * @returns A `ResolvedOperations<Ops>` object pairing the entity config with its operations.
 *
 * @example
 * ```ts
 * export const MessageOps = defineOperations(Message, {
 *   byThread:   op.lookup({ by: ['threadId'], sort: 'createdAt' }),
 *   markRead:   op.fieldUpdate({ match: ['id'], set: { status: 'read' } }),
 *   threadCount: op.aggregate({ groupBy: 'threadId', compute: { total: 'count' } }),
 * });
 * // Later: createEntityFactories(Message, MessageOps.operations)
 * ```
 */
export function defineOperations<Ops extends Record<string, OperationConfig>>(
  entityConfig: ResolvedEntityConfig,
  operations: Ops,
): ResolvedOperations<Ops> {
  return { entityConfig, operations };
}
