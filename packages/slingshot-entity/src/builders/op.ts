/**
 * op.*() builder API for operation definitions.
 *
 * Each builder adds the `kind` discriminant and returns a typed config object.
 * Pure functions — no side effects, no validation (that's defineOperations' job).
 */
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
  PipeOpConfig,
  SearchOpConfig,
  TransactionOpConfig,
  TransitionOpConfig,
  UpsertOpConfig,
} from '../types';

/**
 * Fluent builder namespace for entity operation definitions.
 *
 * Each method accepts the operation-specific config (without the `kind`
 * discriminant) and injects the correct `kind` string. Pass the results into
 * `defineOperations()` to validate field references and freeze the config.
 *
 * @remarks
 * `op.*()` builders are pure — they perform no validation. Validation (field
 * existence, constraint checks) happens when the returned config is passed to
 * `defineOperations()`.
 *
 * @example
 * ```ts
 * import { defineOperations, op } from '@lastshotlabs/slingshot-entity';
 * import { Task } from './task.entity';
 *
 * export const TaskOps = defineOperations(Task, {
 *   byAssignee: op.lookup({ fields: { assigneeId: 'param:userId' }, returns: 'many' }),
 *   complete:   op.transition({ field: 'status', from: 'open', to: 'done', match: { id: 'param:id' } }),
 *   bulkClose:  op.batch({ action: 'update', filter: { status: 'open' }, set: { status: 'closed' } }),
 * });
 * ```
 */
export const op = {
  /**
   * Query entity records by one or more field values.
   *
   * @param config - Lookup config without the `kind` discriminant.
   * @returns A `LookupOpConfig`.
   *
   * @example
   * ```ts
   * op.lookup({ fields: { roomId: 'param:roomId' }, returns: 'many' })
   * op.lookup({ fields: { email: 'param:email' }, returns: 'one' })
   * ```
   */
  lookup: <C extends Omit<LookupOpConfig, 'kind'>>(config: C): C & { kind: 'lookup' } => ({
    kind: 'lookup',
    ...config,
  }),

  /**
   * Check whether a record matching given criteria exists.
   *
   * @param config - Exists config without the `kind` discriminant.
   * @returns An `ExistsOpConfig`.
   *
   * @example
   * ```ts
   * op.exists({ fields: { email: 'param:email' } })
   * ```
   */
  exists: (config: Omit<ExistsOpConfig, 'kind'>): ExistsOpConfig => ({
    kind: 'exists',
    ...config,
  }),

  /**
   * Atomically move a record from one field state to another (state machine step).
   *
   * The adapter reads the current value of `field`, rejects the operation if
   * it does not match `from`, then sets it to `to` along with any `set` fields.
   *
   * @param config - Transition config without the `kind` discriminant.
   * @returns A `TransitionOpConfig`.
   *
   * @example
   * ```ts
   * op.transition({ field: 'status', from: 'draft', to: 'published', match: { id: 'param:id' } })
   * ```
   */
  transition: (config: Omit<TransitionOpConfig, 'kind'>): TransitionOpConfig => ({
    kind: 'transition',
    ...config,
  }),

  /**
   * Update a specific subset of mutable fields on a record.
   *
   * Validates that none of the `set` fields are marked `immutable` on the entity.
   *
   * @param config - FieldUpdate config without the `kind` discriminant.
   * @returns A `FieldUpdateOpConfig`.
   *
   * @example
   * ```ts
   * op.fieldUpdate({ match: { id: 'param:id' }, set: ['title', 'body'] })
   * ```
   */
  fieldUpdate: (config: Omit<FieldUpdateOpConfig, 'kind'>): FieldUpdateOpConfig => ({
    kind: 'fieldUpdate',
    ...config,
  }),

  /**
   * Append a value to an array field on a record identified by its primary key.
   *
   * When `dedupe` is true (the default), the value is only appended if it is not
   * already present — making the operation idempotent.
   *
   * Value binding syntax:
   * - `'ctx:key'`   — from Hono context (e.g. `'ctx:authUserId'`)
   * - `'param:key'` — from URL path param
   * - `'input:key'` — from JSON request body field
   * - literal       — constant value
   *
   * Route: `POST /{entity}/:id/{op-kebab}`
   *
   * @param config - ArrayPush config without the `kind` discriminant.
   * @returns An `ArrayPushOpConfig`.
   *
   * @example
   * ```ts
   * op.arrayPush({ field: 'watchers', value: 'ctx:authUserId', dedupe: true })
   * op.arrayPush({ field: 'tags',     value: 'input:tag' })
   * ```
   */
  arrayPush: (config: Omit<ArrayPushOpConfig, 'kind'>): ArrayPushOpConfig => ({
    kind: 'arrayPush',
    ...config,
  }),

  /**
   * Remove all occurrences of a value from an array field on a record identified
   * by its primary key.
   *
   * Uses the same value binding syntax as `op.arrayPush`.
   *
   * Route: `DELETE /{entity}/:id/{op-kebab}`
   *
   * @param config - ArrayPull config without the `kind` discriminant.
   * @returns An `ArrayPullOpConfig`.
   *
   * @example
   * ```ts
   * op.arrayPull({ field: 'watchers', value: 'ctx:authUserId' })
   * op.arrayPull({ field: 'tags',     value: 'input:tag' })
   * ```
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
   * @param config - ArraySet config without the `kind` discriminant.
   * @returns An `ArraySetOpConfig`.
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
   * Compute aggregate statistics (count, sum, avg, min, max) across matching records.
   *
   * @param config - Aggregate config without the `kind` discriminant.
   * @returns An `AggregateOpConfig`.
   *
   * @example
   * ```ts
   * op.aggregate({ groupBy: 'status', compute: { count: { fn: 'count' } } })
   * ```
   */
  aggregate: (config: Omit<AggregateOpConfig, 'kind'>): AggregateOpConfig => ({
    kind: 'aggregate',
    ...config,
  }),

  /**
   * Aggregate data from a source entity and materialize the result onto a
   * target entity field.
   *
   * @param config - ComputedAggregate config without the `kind` discriminant.
   * @returns A `ComputedAggregateOpConfig`.
   *
   * @example
   * ```ts
   * op.computedAggregate({
   *   source: 'orders',
   *   target: 'user',
   *   sourceFilter: { userId: 'param:userId' },
   *   compute: { orderCount: { fn: 'count' } },
   *   materializeTo: 'stats',
   *   targetMatch: { id: 'param:userId' },
   * })
   * ```
   */
  computedAggregate: (
    config: Omit<ComputedAggregateOpConfig, 'kind'>,
  ): ComputedAggregateOpConfig => ({
    kind: 'computedAggregate',
    ...config,
  }),

  /**
   * Apply a bulk update or delete to all records matching a filter.
   *
   * @param config - Batch config without the `kind` discriminant.
   * @returns A `BatchOpConfig`.
   *
   * @example
   * ```ts
   * op.batch({ action: 'update', filter: { status: 'draft' }, set: { status: 'archived' } })
   * op.batch({ action: 'delete', filter: { expiredAt: { $lt: 'now' } } })
   * ```
   */
  batch: (config: Omit<BatchOpConfig, 'kind'>): BatchOpConfig => ({
    kind: 'batch',
    ...config,
  }),

  /**
   * Insert a new record or update an existing one based on a set of match fields.
   *
   * The `match` fields should have a corresponding unique constraint on the entity
   * (validated by the audit runner).
   *
   * @param config - Upsert config without the `kind` discriminant.
   * @returns An `UpsertOpConfig`.
   *
   * @example
   * ```ts
   * op.upsert({ match: ['email'], set: ['name', 'avatarUrl'] })
   * ```
   */
  upsert: (config: Omit<UpsertOpConfig, 'kind'>): UpsertOpConfig => ({
    kind: 'upsert',
    ...config,
  }),

  /**
   * Full-text or keyword search across specified fields.
   *
   * Generates backend-specific search queries (FTS5 for SQLite, $text for
   * Mongo, GIN tsvector for Postgres, memory adapter substring match).
   *
   * @param config - Search config without the `kind` discriminant.
   * @returns A `SearchOpConfig`.
   *
   * @example
   * ```ts
   * op.search({ fields: ['title', 'body'], paginate: true })
   * ```
   */
  search: (config: Omit<SearchOpConfig, 'kind'>): SearchOpConfig => ({
    kind: 'search',
    ...config,
  }),

  /**
   * Manage an embedded JSON array (sub-document collection) within a parent record.
   *
   * Generates routes for list, add, remove, update, and set operations on the
   * array stored under `parentKey`.
   *
   * @param config - Collection config without the `kind` discriminant.
   * @returns A `CollectionOpConfig`.
   *
   * @example
   * ```ts
   * op.collection({
   *   parentKey: 'attachments',
   *   itemFields: { url: field.string(), name: field.string() },
   *   operations: ['list', 'add', 'remove'],
   *   identifyBy: 'url',
   * })
   * ```
   */
  collection: (config: Omit<CollectionOpConfig, 'kind'>): CollectionOpConfig => ({
    kind: 'collection',
    ...config,
  }),

  /**
   * Find and atomically consume (delete) a single matching record.
   *
   * Useful for one-time-use tokens, queue items, and reservation patterns.
   *
   * @param config - Consume config without the `kind` discriminant.
   * @returns A `ConsumeOpConfig`.
   *
   * @example
   * ```ts
   * op.consume({
   *   filter: { token: 'param:token' },
   *   returns: 'entity',
   *   expiry: { field: 'expiresAt' },
   * })
   * ```
   */
  consume: (config: Omit<ConsumeOpConfig, 'kind'>): ConsumeOpConfig => ({
    kind: 'consume',
    ...config,
  }),

  /**
   * Derive a merged result by combining records from multiple source entities.
   *
   * Sources are resolved at runtime; the merge strategy controls how results
   * from each source are combined.
   *
   * @param config - Derive config without the `kind` discriminant.
   * @returns A `DeriveOpConfig`.
   *
   * @example
   * ```ts
   * op.derive({
   *   sources: [{ from: 'directMessages', where: { userId: 'param:userId' } }],
   *   merge: 'union',
   * })
   * ```
   */
  derive: (config: Omit<DeriveOpConfig, 'kind'>): DeriveOpConfig => ({
    kind: 'derive',
    ...config,
  }),

  /**
   * Execute a sequence of operations atomically across one or more entities.
   *
   * @param config - Transaction config without the `kind` discriminant.
   * @returns A `TransactionOpConfig`.
   *
   * @remarks
   * Atomicity guarantees depend on the backend. SQLite and Postgres composite
   * adapters provide true transactions. Memory executes steps sequentially in
   * process. Redis and Mongo composite adapters currently execute sequentially
   * without rollback on failure.
   *
   * @example
   * ```ts
   * op.transaction({
   *   steps: [
   *     { op: 'update', entity: 'Order', match: { id: 'param:orderId' }, set: { status: 'paid' } },
   *     { op: 'create', entity: 'Invoice', input: { orderId: 'param:orderId' } },
   *   ],
   * })
   * ```
   */
  transaction: (config: Omit<TransactionOpConfig, 'kind'>): TransactionOpConfig => ({
    kind: 'transaction',
    ...config,
  }),

  /**
   * Chain the output of one operation step into the input of the next.
   *
   * @param config - Pipe config without the `kind` discriminant.
   * @returns A `PipeOpConfig`.
   *
   * @example
   * ```ts
   * op.pipe({
   *   steps: [
   *     { op: 'lookup', config: { fields: { id: 'param:id' }, returns: 'one' } },
   *     { op: 'fieldUpdate', config: { match: { id: 'param:id' }, set: ['viewCount'] }, input: { id: 'id' } },
   *   ],
   * })
   * ```
   */
  pipe: (config: Omit<PipeOpConfig, 'kind'>): PipeOpConfig => ({
    kind: 'pipe',
    ...config,
  }),

  /**
   * Atomically increment (or decrement) a numeric field on a matching record.
   *
   * The record is identified by the `match` filter. Pass a negative `by` to
   * decrement. All backends perform the increment atomically where supported.
   *
   * @param config - Increment config without the `kind` discriminant.
   * @returns An `IncrementOpConfig`.
   *
   * @example
   * ```ts
   * op.increment({ field: 'views', by: 1, match: { id: 'param:id' } })
   * op.increment({ field: 'balance', by: -50, match: { id: 'param:userId' } })
   * ```
   */
  increment: (config: Omit<IncrementOpConfig, 'kind'>): IncrementOpConfig => ({
    kind: 'increment',
    ...config,
  }),

  /**
   * Escape hatch for operations that don't fit the built-in kinds.
   *
   * Provide per-backend implementation functions directly. The handler
   * receives the backend driver (e.g. the SQLite `db`, Postgres `pool`,
   * Mongo model) and returns the operation result.
   *
   * @param config - Custom op config without the `kind` discriminant.
   * @returns A `CustomOpConfig`.
   *
   * @example
   * ```ts
   * op.custom({
   *   sqlite:   (db)    => (input) => db.query('SELECT ...', [input.id]),
   *   postgres: (pool)  => (input) => pool.query('SELECT ...', [input.id]),
   *   memory:   (store) => (input) => store.get(input.id),
   * })
   * ```
   */
  custom: <Fn>(config: Omit<CustomOpConfig<Fn>, 'kind'>): CustomOpConfig<Fn> => ({
    kind: 'custom',
    ...config,
  }),
} as const;
