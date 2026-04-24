/**
 * Operation configuration types — canonical definitions.
 *
 * 12 declarative operation patterns + 1 custom escape hatch.
 * Both the codegen package (`slingshot-data`) and the runtime framework import from here.
 * Single source of truth — never duplicate these types in consumer packages.
 *
 * @remarks
 * Operation configs are consumed by:
 * - `slingshot-data` code generators to produce typed adapter implementations
 * - The runtime framework's `op.*` executor registry for live evaluation
 * - `InferOperationMethods<Ops, Entity>` for TypeScript adapter method typing
 */
import type { FieldDef } from './entityConfig';
import type { ResolvedEntityConfig } from './entityConfig';
// ---------------------------------------------------------------------------
// Type-level operation method inference
// ---------------------------------------------------------------------------

import type { PaginatedResult } from './entityConfig';

// ---------------------------------------------------------------------------
// Filter expression types
// ---------------------------------------------------------------------------

/** Not-equal filter operator: `{ $ne: value }` */
export interface FilterNe {
  readonly $ne: string | number | boolean | null;
}
/** Greater-than filter operator: `{ $gt: value }` — supports `'now'` for date comparisons. */
export interface FilterGt {
  readonly $gt: string | number;
}
/** Greater-than-or-equal filter operator. Supports `'now'` for date comparisons. */
export interface FilterGte {
  readonly $gte: string | number;
}
/** Less-than filter operator. Supports `'now'` for date comparisons. */
export interface FilterLt {
  readonly $lt: string | number;
}
/** Less-than-or-equal filter operator. Supports `'now'` for date comparisons. */
export interface FilterLte {
  readonly $lte: string | number;
}
/** Inclusion filter: field value must be in the provided array. */
export interface FilterIn {
  readonly $in: ReadonlyArray<string | number>;
}
/** Exclusion filter: field value must NOT be in the provided array. */
export interface FilterNin {
  readonly $nin: ReadonlyArray<string | number>;
}
/** Case-insensitive substring filter: field value must contain the string. */
export interface FilterContains {
  readonly $contains: string;
}

/**
 * Union of all supported comparison operator objects for a single field filter.
 */
export type FilterOperator =
  | FilterNe
  | FilterGt
  | FilterGte
  | FilterLt
  | FilterLte
  | FilterIn
  | FilterNin
  | FilterContains;

/**
 * A single field's filter value — a literal, `null`, or a comparison operator.
 *
 * String values starting with `'param:'` are treated as parameter references
 * resolved at runtime (e.g. `'param:userId'` resolves to the `userId` param).
 * The sentinel `'now'` in comparison operators resolves to `new Date()`.
 *
 * @remarks
 * The `'param:x'` prefix is a runtime injection mechanism: the executor reads
 * the call-time `params` map and substitutes the value of key `x` before the
 * filter reaches the database adapter. This means filters can be defined
 * statically in the operation config while still accepting dynamic values per call.
 * Literal strings that do not start with `'param:'` are passed through unchanged
 * as constant equality checks.
 */
export type FilterValue = string | number | boolean | null | FilterOperator;

/**
 * A composable filter expression for entity queries.
 *
 * Top-level fields are field-level equality/operator checks. `$and` and `$or`
 * allow logical composition of sub-expressions.
 *
 * @remarks
 * Evaluation order: top-level field conditions are combined with an implicit AND.
 * `$and` further ANDs an array of sub-expressions; `$or` ORs them. When both
 * `$and` and `$or` are present on the same level they are themselves combined
 * with AND (i.e. all `$and` clauses AND the `$or` clause must hold). Sub-expressions
 * inside `$and`/`$or` are themselves full `FilterExpression` objects and may nest
 * further `$and`/`$or` arrays.
 *
 * @example
 * ```ts
 * const filter: FilterExpression = {
 *   status: 'active',
 *   createdAt: { $gt: 'param:after' },
 *   $or: [{ role: 'admin' }, { role: 'moderator' }],
 * };
 * ```
 */
export type FilterExpression = {
  readonly $and?: ReadonlyArray<FilterExpression>;
  readonly $or?: ReadonlyArray<FilterExpression>;
  readonly [key: string]: FilterValue | ReadonlyArray<FilterExpression> | undefined;
};

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Aggregate computation function names used in `op.aggregate` and `op.computedAggregate`.
 *
 * - `'count'` — number of records in the group (always an integer)
 * - `'sum'`   — numeric sum of a specified field across the group
 * - `'avg'`   — arithmetic mean of a specified field across the group
 * - `'min'`   — smallest value of a specified field in the group
 * - `'max'`   — largest value of a specified field in the group
 */
export type ComputeSpec = 'count' | 'sum' | 'avg' | 'min' | 'max';

/**
 * A field-level computed aggregate specification.
 * Used in `op.aggregate` to declare what to compute across grouped records.
 */
export interface ComputedField {
  /** Count all records in the group. */
  readonly count?: boolean;
  /**
   * Count records grouped by the distinct values of this field.
   * The result is a `Record<string, number>` mapping each distinct value to its count.
   */
  readonly countBy?: string;
  /**
   * Sum the values of this numeric field across all records in the group.
   * Non-numeric or null values are treated as 0.
   */
  readonly sum?: string;
  /**
   * Pre-aggregate filter: only records matching all conditions here are included
   * in the computation. Applied before `count`, `countBy`, or `sum`.
   */
  readonly where?: Record<string, FilterValue>;
}

/**
 * Strategy for merging results from multiple sources in `op.derive`.
 *
 * - `'union'`     — deduplicate by ID across all sources
 * - `'concat'`    — concatenate all results in source order
 * - `'intersect'` — return only IDs present in all sources
 * - `'first'`     — return results from the first non-empty source only
 * - `'priority'`  — like first, but sources are weighted by configuration
 *
 * @example
 * ```ts
 * // union: [A, B, A, C] → [A, B, C]  (deduped by ID)
 * // concat: [A, B] + [A, C] → [A, B, A, C]  (preserves duplicates)
 * // intersect: [A, B, C] ∩ [B, C, D] → [B, C]  (only shared IDs)
 * // first: sources=['feed','trending'] → returns 'feed' results if non-empty, else 'trending'
 * // priority: same as first but sources carry numeric weight in config
 * ```
 */
export type MergeStrategy = 'union' | 'concat' | 'intersect' | 'first' | 'priority';

// ---------------------------------------------------------------------------
// Operation configs
// ---------------------------------------------------------------------------

/**
 * Lookup operation — find one or many records by matching field values.
 *
 * `fields` maps entity field names to `'param:x'` references or literals.
 * `returns: 'one'` produces `Entity | null`; `returns: 'many'` produces a paginated list.
 *
 * @example
 * ```ts
 * const op: LookupOpConfig = { kind: 'lookup', fields: { id: 'param:id' }, returns: 'one' };
 * ```
 */
export interface LookupOpConfig {
  readonly kind: 'lookup';
  /**
   * Field-to-value match conditions for the lookup.
   *
   * Each value may be a `'param:x'` reference (resolved from call-time params),
   * or a literal scalar treated as a constant equality condition.
   *
   * @example
   * ```ts
   * // 'param:id' → resolved from params.id at runtime
   * // 'active'   → literal equality: field === 'active'
   * fields: { id: 'param:id', status: 'active' }
   * ```
   */
  readonly fields: Record<string, string | number | boolean>;
  /**
   * Controls the return shape of the generated method.
   *
   * - `'one'`  — resolves to `Entity | null` (the first matching record or null)
   * - `'many'` — resolves to `PaginatedResult<Entity>` (all matching records, paginated)
   *
   * @example
   * ```ts
   * // returns: 'one'  → getById(params) => Promise<Entity | null>
   * // returns: 'many' → listByStatus(params) => Promise<PaginatedResult<Entity>>
   * ```
   */
  readonly returns: 'one' | 'many';
}

/**
 * Exists operation — check whether at least one record satisfies a field match.
 *
 * More efficient than `lookup` when you only need a boolean result.
 * Optional `check` fields narrow the test beyond the primary match.
 */
export interface ExistsOpConfig {
  readonly kind: 'exists';
  /** Field-to-param/literal match conditions. */
  readonly fields: Record<string, string>;
  /**
   * Additional field equality assertions evaluated with AND semantics.
   * Every key-value pair in `check` must match for the record to be counted.
   * These conditions are combined with the `fields` conditions — both sets
   * must hold simultaneously. Useful for asserting state alongside the primary key match
   * (e.g. confirm a token is unused while looking it up by value).
   */
  readonly check?: Record<string, string | number | boolean>;
}

/**
 * Transition operation — atomically move a record from one state to another.
 *
 * The operation matches a record by `match` fields, verifies the current value of
 * `field` equals `from`, then updates it to `to`. Optional `set` fields are updated
 * at the same time. Useful for state machine transitions (e.g., `pending` → `active`).
 */
export interface TransitionOpConfig {
  readonly kind: 'transition';
  /** The entity field that holds the state value. */
  readonly field: string;
  /** Expected current value or values (the transition only proceeds if one matches). */
  readonly from: string | number | boolean | readonly (string | number | boolean)[];
  /** Value to transition to. */
  readonly to: string | number | boolean;
  /** Field-to-param match conditions for record identification. */
  readonly match: Record<string, string>;
  /**
   * Additional fields to set atomically alongside the state transition.
   * Values may be:
   * - A `'param:x'` reference resolved from call-time params.
   * - A literal string value.
   * - The sentinel `'now'`, which is substituted with `new Date()` at execution time —
   *   useful for recording a `transitionedAt` or `updatedAt` timestamp.
   */
  readonly set?: Record<string, string>;
  /** Return the updated entity or just a boolean success flag. Default: `'entity'`. */
  readonly returns?: 'entity' | 'boolean';
}

/**
 * Field update operation — selectively update a subset of fields on a matched record.
 *
 * More targeted than a full `update` — only the fields listed in `set` can be mutated.
 * Useful for operations that update one attribute without overwriting others (e.g., mark as read).
 */
export interface FieldUpdateOpConfig {
  readonly kind: 'fieldUpdate';
  /** Field-to-param match conditions for record identification. */
  readonly match: Record<string, string>;
  /** Names of the entity fields that this operation is allowed to mutate. */
  readonly set: readonly string[];
  /**
   * When `true`, all fields listed in `set` become optional in the generated method's
   * input type. Fields omitted from the call are left unchanged on the record.
   * Required params (those referenced in `match`) are unaffected and remain mandatory.
   */
  readonly partial?: boolean;
  /**
   * When `true`, `null` is accepted as a value for any field in `set`.
   * When `false` or omitted (the default), passing `null` for a `set` field is a
   * type error — use this when the entity schema disallows null for those fields.
   */
  readonly nullable?: boolean;
}

/** Supported truncation levels for date-based groupBy. */
export type DateTruncation = 'year' | 'month' | 'week' | 'day' | 'hour';

/**
 * Object form of `groupBy` with optional date truncation.
 *
 * When `truncate` is provided, the raw field value is converted to a date and
 * truncated to the specified granularity before grouping. This allows grouping
 * date fields by month, day, etc., without requiring a separate denormalized field.
 *
 * @example
 * ```ts
 * // Group transactions by month from a full date field:
 * { field: 'date', truncate: 'month' }   // keys become "2026-04", "2026-05", etc.
 * ```
 */
export interface GroupByConfig {
  /** Field name to group by. */
  readonly field: string;
  /** Truncate date values to this granularity before grouping. */
  readonly truncate?: DateTruncation;
}

/**
 * Aggregate operation — compute summary statistics over a set of records.
 *
 * Optionally groups results by a field value. Each key in `compute` produces a
 * calculated column (count, sum, avg, min, max).
 */
export interface AggregateOpConfig {
  readonly kind: 'aggregate';
  /**
   * Field name or config to group by.
   *
   * **String form:** groups by exact field values.
   *
   * **Object form:** `{ field, truncate? }` — optionally truncates date values
   * to a coarser granularity (year, month, week, day, hour) before grouping.
   *
   * When provided, the result is an array of objects — one per distinct (possibly
   * truncated) value of this field — each containing the group key and the
   * computed columns. When omitted, a single global aggregate is computed over
   * all matching records and the result is a plain object (not an array).
   */
  readonly groupBy?: string | GroupByConfig;
  /** Columns to compute: field name → compute spec or computed field definition. */
  readonly compute: Record<string, ComputeSpec | ComputedField>;
  /** Filter applied before aggregating. */
  readonly filter?: FilterExpression;
}

/**
 * Computed aggregate operation — query one entity, aggregate it, and materialise
 * the result back into another entity (the "target").
 *
 * Used for denormalised summary fields (e.g., `commentCount` on a `Post`).
 */
export interface ComputedAggregateOpConfig {
  readonly kind: 'computedAggregate';
  /** The source entity storage name to aggregate from. */
  readonly source: string;
  /** The target entity storage name to write the result into. */
  readonly target: string;
  /** Filter applied to source records before aggregating. */
  readonly sourceFilter: FilterExpression;
  /** Columns to compute on the filtered source records. */
  readonly compute: Record<string, ComputeSpec | ComputedField>;
  /** Target field to materialise the result into. */
  readonly materializeTo: string;
  /** Additional fields to derive and write into the target. */
  readonly deriveFields?: Record<string, { fn: string; args: readonly string[] }>;
  /** Match conditions for identifying the target record to update. */
  readonly targetMatch: Record<string, string>;
  /**
   * When true, the multi-step read-aggregate-write is wrapped in a real backend
   * transaction when the store supports one.
   *
   * Ordinary single-statement operations should not require consumers to ask for
   * transactions; this flag exists because `computedAggregate` is inherently a
   * multi-step flow with a real semantic/performance tradeoff.
   */
  readonly atomic?: boolean;
}

/**
 * Batch operation — update or delete multiple records matching a filter in one call.
 *
 * Returns the number of affected rows. Optionally atomic (transaction-wrapped)
 * when the backend supports a real transaction and the caller wants the stricter
 * boundary.
 */
export interface BatchOpConfig {
  readonly kind: 'batch';
  /** Whether to update or hard-delete matched records. */
  readonly action: 'update' | 'delete';
  /** Filter expression selecting the records to act on. */
  readonly filter: FilterExpression;
  /** Fields to set when `action` is `'update'`. `'now'` auto-sets to current timestamp. */
  readonly set?: Record<string, string | number | boolean>;
  /**
   * Whether to wrap the operation in a transaction.
   *
   * This is exposed here because `batch` can represent a multi-step backend flow
   * or a semantic boundary where callers may want stricter guarantees. Standard
   * single-record operations should not need a consumer-facing transaction flag.
   */
  readonly atomic?: boolean;
  /** Return the count of affected rows, or `void`. Default: `'count'`. */
  readonly returns?: 'count' | 'void';
}

/**
 * Upsert operation — create or update a record based on uniqueness fields.
 *
 * Matches on the fields listed in `match`. If a record exists, updates the `set` fields.
 * If not, creates a new record applying `onCreate` defaults.
 */
export interface UpsertOpConfig {
  readonly kind: 'upsert';
  /** Fields used to determine uniqueness (the upsert key). */
  readonly match: readonly string[];
  /** Fields to update on match (or set on create). */
  readonly set: readonly string[];
  /**
   * Default values applied only when a new record is being created (no existing match found).
   * These are not applied during updates.
   *
   * Supported sentinels:
   * - `'uuid'`  — auto-generates a v4 UUID at creation time
   * - `'cuid'`  — auto-generates a CUID (collision-resistant, URL-safe) at creation time
   * - `'now'`   — substitutes the current `Date` at creation time
   * - Any other string is treated as a literal value written as-is to the field
   */
  readonly onCreate?: Record<string, string>;
  /**
   * What to return from the upsert call.
   *
   * - `'entity'` — resolves to the entity record (created or updated)
   * - `{ entity: true; created: true }` — resolves to `{ entity: Entity; created: boolean }`
   *   where `created` is `true` when the record was inserted and `false` when it was updated
   *
   * @example
   * ```ts
   * // returns: 'entity'
   * const user = await ops.ensureUser({ email });
   * // user: User
   *
   * // returns: { entity: true, created: true }
   * const { entity: user, created } = await ops.ensureUser({ email });
   * if (created) await sendWelcomeEmail(user);
   * ```
   */
  readonly returns?: 'entity' | { entity: true; created: true };
}

/**
 * Search operation — full-text or filtered search across entity records.
 *
 * When `useSearchProvider` is `true` (default when the entity has a `search` config),
 * the search is delegated to the configured search provider (e.g., Meilisearch).
 * Otherwise, a DB-native LIKE/text search is used.
 */
export interface SearchOpConfig {
  readonly kind: 'search';
  /** Entity fields to search across (full-text). */
  readonly fields: readonly string[];
  /** Additional filter expression applied alongside the text query. */
  readonly filter?: FilterExpression;
  /** When true, results are cursor-paginated. Default: false. */
  readonly paginate?: boolean;
  /**
   * When `true` and a search provider is available, delegate to the provider instead of DB-native.
   * Default: `true` when the entity has a `search` config.
   *
   * When `false`, or when the entity has no `search` config, the operation falls back to a
   * DB-native LIKE/full-text query against the fields listed in `fields`. The fallback is
   * always available regardless of search provider configuration, so this flag can be set
   * to `false` to force DB-native search even when a provider is configured.
   */
  readonly useSearchProvider?: boolean;
}

/**
 * Valid operations on a collection (embedded array of sub-documents).
 */
export type CollectionOperation = 'list' | 'add' | 'remove' | 'update' | 'set';

/**
 * Collection operation — manage an embedded ordered list of sub-documents within a parent entity.
 *
 * Provides typed list/add/remove/update/set methods for arrays stored as a JSON field
 * (Postgres/SQLite) or embedded array (Mongo).
 */
export interface CollectionOpConfig {
  readonly kind: 'collection';
  /** The parent entity field that holds the embedded array. */
  readonly parentKey: string;
  /** Field definitions for each item in the collection. */
  readonly itemFields: Record<string, FieldDef>;
  /** Which CRUD sub-operations to generate. */
  readonly operations: readonly CollectionOperation[];
  /**
   * Field used to uniquely identify items within the collection for `remove` and `update` operations.
   *
   * @remarks
   * Defaults to `'id'` when omitted. Override when the collection items use a different
   * natural key (e.g. `'slug'`, `'email'`). The value of this field is passed as
   * `identifyValue` to the generated `remove(parentId, identifyValue)` and
   * `update(parentId, identifyValue, updates)` methods.
   */
  readonly identifyBy?: string;
  /** Maximum number of items in the collection (param reference or literal number). */
  readonly maxItems?: string | number;
}

/**
 * Consume operation — atomically read and delete a record in a single call.
 *
 * Used for one-time-use tokens, OTPs, magic links, and other single-claim resources.
 * Optional `expiry` field check rejects records that have passed their TTL.
 */
export interface ConsumeOpConfig {
  readonly kind: 'consume';
  /** Filter for the record to consume. */
  readonly filter: FilterExpression;
  /** Whether to return the consumed entity or just a boolean success flag. */
  readonly returns: 'boolean' | 'entity';
  /**
   * When provided, the consume operation checks the named field against the current time.
   * If the field value is less than `now` (i.e. the timestamp is in the past), the record
   * is treated as expired and the operation returns `false` / `null` without deleting it.
   * The comparison is `record[field] < new Date()` — the field must hold a `Date` or epoch
   * millisecond timestamp.
   */
  readonly expiry?: { field: string };
}

/**
 * A single data source for a `DeriveOpConfig`.
 *
 * Specifies an entity to query (`from`) with match conditions (`where`).
 * Optional `traverse` resolves a relation to a different entity.
 */
export interface DeriveSource {
  /** The entity storage name to query from. */
  readonly from: string;
  /** Field-to-param/literal or field-to-null match conditions. */
  readonly where: Record<string, string | null>;
  /** Field to return from matched records. Omit to return full records. */
  readonly select?: string;
  /**
   * Optional one-hop relation traversal to a linked entity.
   *
   * After matching records in `from`, the executor reads the foreign-key field
   * named `on` from each matched record and uses those values to look up records
   * in the `to` entity, returning the `select` field from each traversed record.
   *
   * @remarks
   * This models a many-to-one or one-to-one traversal — each record in `from`
   * yields at most one traversed record (the foreign key must be a scalar, not an
   * array). For one-to-many relations, use a separate source with a `where` condition
   * referencing the parent IDs via a `'param:x'` injection or post-filter.
   */
  readonly traverse?: {
    /** The entity storage name to traverse to. */
    readonly to: string;
    /** The field in `from` that holds the foreign key. */
    readonly on: string;
    /** The field to select from the traversed entity. */
    readonly select: string;
  };
}

/**
 * Derive operation — compose results from multiple entity sources.
 *
 * Queries each source in `sources` and merges the results according to `merge`.
 * Useful for "feed" or "inbox" queries that pull from multiple entity types.
 */
export interface DeriveOpConfig {
  readonly kind: 'derive';
  /** The ordered list of sources to query. */
  readonly sources: readonly DeriveSource[];
  /** How to combine results from multiple sources. */
  readonly merge: MergeStrategy;
  /** When true, arrays in the result are flattened one level. */
  readonly flatten?: boolean;
  /** Filter applied to the merged result set. */
  readonly postFilter?: FilterExpression;
}

/**
 * Custom operation — escape hatch for operations that cannot be expressed declaratively.
 *
 * Each backend key is an optional factory that receives the raw store handle and returns
 * a typed callable. Only the factory for the active `StoreType` is called at runtime.
 *
 * **Factory vs. external method:**
 * When backend factories are provided, the wiring layer calls the appropriate factory and
 * attaches the result as the named method on the adapter. When no factory is provided for
 * the active backend, the method is expected to be mixed onto the adapter externally
 * (e.g., from a composite adapter) — the wiring layer skips the op silently.
 *
 * **Route auto-mounting:**
 * Set `http` to have the entity plugin auto-mount an HTTP route for this operation.
 * The method in `http.method` controls the HTTP verb; `http.path` overrides the URL
 * segment (defaults to `/{opName}` in kebab-case). The route handler calls
 * `adapter[opName](body)` — the method must be present on the adapter at request time,
 * whether wired by a factory or mixed in externally.
 *
 * @example
 * ```ts
 * // Factory-wired op with auto-mounted route:
 * op.custom({
 *   http: { method: 'post' },
 *   postgres: (pool) => async (userId: string) => {
 *     const { rows } = await pool.query('SELECT count(*) FROM posts WHERE author_id = $1', [userId]);
 *     return parseInt(rows[0].count, 10);
 *   },
 * })
 *
 * // Route-only marker for a method mixed in from a composite adapter:
 * op.custom({ http: { method: 'post' } })
 * ```
 */
export interface CustomOpConfig<Fn = unknown> {
  readonly kind: 'custom';
  /**
   * HTTP route metadata for auto-mounting via the entity plugin.
   *
   * When set, `buildBareEntityRoutes` mounts a route at `/{segment}/{opName}` using the
   * declared method. The handler calls `adapter[opName](body)`.
   * When omitted, no route is auto-mounted (the op is adapter-only).
   */
  readonly http?: {
    /** HTTP method for the auto-mounted route. */
    readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete';
    /**
     * URL path segment override. When omitted, the op name is kebab-cased and appended
     * to the entity segment (e.g. `revertDocument` → `/documents/revert-document`).
     */
    readonly path?: string;
  };
  /** Factory for the in-memory store (receives the `Map<string, Record<...>>` backing map). */
  readonly memory?: (store: Map<string, Record<string, unknown>>) => Fn;
  /** Factory for the SQLite backend (receives the database handle). */
  readonly sqlite?: (db: unknown) => Fn;
  /** Factory for the MongoDB backend (receives the Mongoose collection). */
  readonly mongo?: (collection: unknown) => Fn;
  /** Factory for the Postgres backend (receives the `pg.Pool`). */
  readonly postgres?: (pool: unknown) => Fn;
  /** Factory for the Redis backend (receives the `RedisLike` client). */
  readonly redis?: (redis: unknown) => Fn;
}

// ---------------------------------------------------------------------------
// op.transaction — cross-entity atomic writes
// ---------------------------------------------------------------------------

/**
 * A single step within a `TransactionOpConfig`.
 *
 * Steps execute in order and can reference the results of earlier steps via
 * `'result:stepIndex.field'` references in `input`. The entire transaction
 * is rolled back if any step fails when the backend provides a real transaction
 * wrapper (currently SQLite and Postgres composite adapters).
 */
export interface TransactionStep {
  /**
   * Which operation to perform on the entity.
   *
   * - `create` — insert a new record (uses `input`)
   * - `update` — full-record replace of a matched record (uses `match` + `set`)
   * - `delete` — hard-delete a matched record (uses `match`)
   * - `fieldUpdate` — partial write of specific fields (uses `match` + `set`)
   * - `transition` — state-machine transition (uses `match` + `field` + `from` + `to`)
   * - `batch` — multi-record update or delete (uses `filter` + `action` + optional `set`)
   * - `arrayPush` — append a value to an array field (uses `match` + `field` + `value` + `dedupe`)
   * - `arrayPull` — remove a value from an array field (uses `match` + `field` + `value`)
   * - `lookup` — read a record without writing; result is available via `result:N.field` (uses `match`)
   * - `increment` — atomically add `by` (default 1) to a numeric field (uses `match` + `field` + `by`)
   */
  readonly op:
    | 'create'
    | 'update'
    | 'delete'
    | 'fieldUpdate'
    | 'transition'
    | 'batch'
    | 'arrayPush'
    | 'arrayPull'
    | 'lookup'
    | 'increment';
  /** Which entity to operate on (key in the composite adapter). */
  readonly entity: string;
  /**
   * Input for the operation.
   *
   * Accepted value types:
   * - Any JSON-serialisable literal (string, number, boolean, null, object, array)
   * - `'param:x'` — resolved from the transaction's call-time `params` map using key `x`
   * - `'result:N.field'` — value extracted from step N's output object using dot-notation
   *   field access (e.g. `'result:0.id'` reads the `id` field of step 0's return value)
   *
   * Step index in `'result:N.field'` is zero-based and must refer to a step that has
   * already executed (i.e. `N < current step index`).
   */
  readonly input?: Record<string, unknown>;
  /** Match condition for `update`, `delete`, `fieldUpdate`, `transition`, `arrayPush`, `arrayPull`, and `lookup` steps. */
  readonly match?: Record<string, string>;
  /** Fields to set for `fieldUpdate` and `batch update` steps. */
  readonly set?: Record<string, unknown>;
  /** Array field name for `arrayPush` and `arrayPull` steps. Also used as the state field for `transition` steps. */
  readonly field?: string;
  /** Expected current state value for `transition` steps. */
  readonly from?: string | number | boolean;
  /** Target state value for `transition` steps. */
  readonly to?: string | number | boolean;
  /** Action for `batch` steps. */
  readonly action?: 'update' | 'delete';
  /** Filter expression for `batch` steps. */
  readonly filter?: FilterExpression;
  /**
   * The value to push or pull for `arrayPush` and `arrayPull` steps.
   * Supports `'param:x'` and `'result:N.field'` references in addition to literals.
   */
  readonly value?: unknown;
  /**
   * When `true` (default for `arrayPush` steps), the value is only pushed if it is
   * not already present — making the push idempotent.
   * Has no effect on `arrayPull`, `lookup`, or `increment` steps.
   */
  readonly dedupe?: boolean;
  /**
   * Amount to add to the numeric field for `increment` steps.
   * Use a negative number to decrement. Defaults to `1`.
   */
  readonly by?: number;
}

/**
 * Transaction operation — execute multiple entity operations atomically.
 *
 * Steps run in order; the whole transaction rolls back on failure when the
 * backend provides a real transaction wrapper.
 *
 * This is the explicit composition boundary for callers who want several
 * operations to behave as one unit. Standard entity operations should remain
 * safe-by-default without requiring consumers to manage transaction strategy.
 *
 * @example
 * ```ts
 * const op: TransactionOpConfig = {
 *   kind: 'transaction',
 *   steps: [
 *     { op: 'update', entity: 'orders', match: { id: 'param:orderId' }, set: { status: 'confirmed' } },
 *     { op: 'create', entity: 'invoices', input: { orderId: 'param:orderId' } },
 *   ],
 * };
 * ```
 */
export interface TransactionOpConfig {
  readonly kind: 'transaction';
  /** Ordered list of atomic steps. */
  readonly steps: readonly TransactionStep[];
}

// ---------------------------------------------------------------------------
// op.pipe — operation composition
// ---------------------------------------------------------------------------

/**
 * A single step within a `PipeOpConfig`.
 *
 * The `input` map allows passing values from the previous step's result using
 * `'result:field'` references, enabling sequential operation chaining.
 */
export interface PipeStep {
  /** The operation kind to run (must be a key in the composite adapter's ops). */
  readonly op: string;
  /** The operation configuration for this step. */
  readonly config: OperationConfig;
  /**
   * Input overrides for this step.
   *
   * Each value may be a `'result:field'` reference that extracts a field from the
   * immediately preceding step's output (e.g. `'result:id'` reads `previousOutput.id`).
   * Only the direct previous step's result is accessible — for multi-step extraction use
   * a `TransactionOpConfig` instead. Literal string values are passed through unchanged.
   */
  readonly input?: Record<string, string>;
}

/**
 * Pipe operation — chain multiple operations where each step feeds into the next.
 *
 * The output of each step is available to the next via `'result:field'` references in `input`.
 * Useful for multi-stage workflows (e.g., create + lookup + enrich).
 */
export interface PipeOpConfig {
  readonly kind: 'pipe';
  /** Ordered list of pipe steps. */
  readonly steps: readonly PipeStep[];
}

// ---------------------------------------------------------------------------
// op.arrayPush — add a value to a JSON array field
// ---------------------------------------------------------------------------

/**
 * Append a value to an array field on a record identified by its primary key.
 *
 * When `dedupe` is true (the default), the value is only appended if it is not
 * already present — making the operation idempotent.
 *
 * The `value` binding is resolved at the HTTP layer before the executor is
 * called. Supported binding syntax:
 * - `'ctx:key'`   → read from Hono context (e.g. `'ctx:actor.id'`)
 * - `'param:key'` → read from URL path param
 * - `'input:key'` → read from JSON request body field
 * - literal       → constant value baked in
 *
 * Route: `POST /{entity}/:id/{op-kebab}`
 *
 * @example
 * ```ts
 * op.arrayPush({ field: 'watchers', value: 'ctx:actor.id', dedupe: true })
 * op.arrayPush({ field: 'tags',     value: 'input:tag' })
 * ```
 */
export interface ArrayPushOpConfig {
  readonly kind: 'arrayPush';
  /** The entity field (must be an array type) to push the value into. */
  readonly field: string;
  /**
   * Binding expression that resolves to the value to push.
   * Format: `'ctx:key'`, `'param:key'`, `'input:key'`, or a literal string.
   */
  readonly value: string;
  /**
   * When true (default), the value is only pushed if not already in the array.
   * Set to false to allow duplicate values.
   */
  readonly dedupe?: boolean;
}

// ---------------------------------------------------------------------------
// op.arrayPull — remove a value from a JSON array field
// ---------------------------------------------------------------------------

/**
 * Remove all occurrences of a value from an array field on a record identified
 * by its primary key.
 *
 * Uses the same `value` binding syntax as `ArrayPushOpConfig`.
 *
 * Route: `DELETE /{entity}/:id/{op-kebab}`
 *
 * @example
 * ```ts
 * op.arrayPull({ field: 'watchers', value: 'ctx:actor.id' })
 * op.arrayPull({ field: 'tags',     value: 'input:tag' })
 * ```
 */
export interface ArrayPullOpConfig {
  readonly kind: 'arrayPull';
  /** The entity field to remove the value from. */
  readonly field: string;
  /**
   * Binding expression that resolves to the value to remove.
   * Format: `'ctx:key'`, `'param:key'`, `'input:key'`, or a literal string.
   */
  readonly value: string;
}

// ---------------------------------------------------------------------------
// op.arraySet — replace an entire JSON array field
// ---------------------------------------------------------------------------

/**
 * Replace the entire contents of an array field on a record identified by its
 * primary key.
 *
 * Unlike `arrayPush` and `arrayPull`, which mutate individual values, `arraySet`
 * performs a full replacement — the stored array becomes exactly `value` (after
 * optional server-side deduplication).
 *
 * The `value` binding is resolved at the HTTP layer before the executor is called.
 * Supported binding syntax:
 * - `'input:key'` → read an array from the JSON request body field `key`
 * - `'param:key'` → read from a URL path param (parsed as JSON if it's an array string)
 * - `'ctx:key'`   → read from Hono context
 * - literal       → constant array baked in (rare)
 *
 * Route: `PUT /{entity}/:id/{op-kebab}` (full-replacement semantics)
 *
 * @example
 * ```ts
 * op.arraySet({ field: 'labelIds', value: 'input:labelIds' })
 * // With dedup disabled (trust the client):
 * op.arraySet({ field: 'tags', value: 'input:tags', dedupe: false })
 * ```
 */
export interface ArraySetOpConfig {
  readonly kind: 'arraySet';
  /** The entity field (must be an array type) to replace. */
  readonly field: string;
  /**
   * Binding expression that resolves to the replacement array.
   * Format: `'input:key'`, `'ctx:key'`, `'param:key'`, or a literal.
   */
  readonly value: string;
  /**
   * When `true` (the default), the incoming array is deduplicated server-side
   * (`[...new Set(incoming)]`) before being written. Preserves the first
   * occurrence of each value; maintains insertion order.
   * Set to `false` to allow duplicate values.
   */
  readonly dedupe?: boolean;
}

// ---------------------------------------------------------------------------
// op.increment — atomic numeric field increment / decrement
// ---------------------------------------------------------------------------

/**
 * Increment (or decrement) a numeric field on a specific record.
 *
 * The record is looked up by primary key. The named field is increased by `by`
 * (default `1`). Pass a negative value for `by` to decrement. All backends
 * perform the increment atomically where the store supports it (Postgres uses
 * `SET field = field + $n`, Mongo uses `$inc`, memory/Redis use read-modify-write).
 *
 * @example
 * ```ts
 * op.increment({ field: 'views' })            // views += 1
 * op.increment({ field: 'version', by: 1 })   // explicit increment
 * op.increment({ field: 'balance', by: -50 }) // decrement by 50
 * ```
 */
export interface IncrementOpConfig {
  readonly kind: 'increment';
  /** The numeric field to increment (or decrement). */
  readonly field: string;
  /**
   * Amount to add to the field on each call.
   * Use a negative number to decrement. Defaults to `1`.
   */
  readonly by?: number;
  /**
   * Filter criteria identifying which record(s) to update.
   * Keys are field names; values use the standard binding syntax
   * (`'param:id'`, `'ctx:userId'`, `'input:key'`, or a literal value).
   * When omitted, the operation matches by primary key passed at call time.
   */
  readonly match?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Union + resolved wrapper
// ---------------------------------------------------------------------------

/**
 * Union of all supported declarative operation configuration types.
 * Used as the value type in `ResolvedOperations.operations` and `PipeStep.config`.
 */
export type OperationConfig =
  | LookupOpConfig
  | ExistsOpConfig
  | TransitionOpConfig
  | FieldUpdateOpConfig
  | AggregateOpConfig
  | ComputedAggregateOpConfig
  | BatchOpConfig
  | UpsertOpConfig
  | SearchOpConfig
  | CollectionOpConfig
  | ConsumeOpConfig
  | DeriveOpConfig
  | TransactionOpConfig
  | PipeOpConfig
  | CustomOpConfig
  | ArrayPushOpConfig
  | ArrayPullOpConfig
  | ArraySetOpConfig
  | IncrementOpConfig;

// ---------------------------------------------------------------------------
// Named resolved-method types — one per op kind.
//
// These are the types you see in IDE hover tooltips on resolved operation
// methods (e.g. `ops.listByOrg`, `ops.changeStatus`). Each is exported so
// consumers can type-check callbacks and wrappers without re-deriving the
// signature from the config type.
// ---------------------------------------------------------------------------

/**
 * Resolved method for a {@link LookupOpConfig} with `returns: 'one'`.
 *
 * Finds a single entity matching the supplied filter params. Returns `null`
 * if no matching record exists — never throws for a missing record.
 *
 * @template Entity - The entity type returned by this operation.
 * @param params - Runtime values for every `'param:x'` placeholder declared
 *   in the operation's `where` clause.
 * @returns The matching entity, or `null` if not found.
 */
export type LookupOneMethod<Entity> = (params: Record<string, unknown>) => Promise<Entity | null>;

/**
 * Resolved method for a {@link LookupOpConfig} without `returns: 'one'`.
 *
 * Returns a cursor-paginated list of entities matching the filter params.
 * The result always includes `items`, `total`, and an optional `nextCursor`.
 *
 * @template Entity - The entity type in the paginated result.
 * @param params - Runtime values for every `'param:x'` placeholder in `where`.
 * @returns A {@link PaginatedResult} containing matched entities and pagination metadata.
 */
export type LookupManyMethod<Entity> = (
  params: Record<string, unknown>,
) => Promise<PaginatedResult<Entity>>;

/**
 * Resolved method for an {@link ExistsOpConfig}.
 *
 * Efficiently checks whether at least one entity matches the filter — does
 * not load the full record. Use instead of a lookup when you only need a
 * boolean (e.g. uniqueness checks, pre-condition guards).
 *
 * @param params - Runtime values for every `'param:x'` placeholder in `where`.
 * @returns `true` if a matching entity exists, `false` otherwise.
 */
export type ExistsMethod = (params: Record<string, unknown>) => Promise<boolean>;

/**
 * Resolved method for a {@link TransitionOpConfig} with `returns: 'boolean'`.
 *
 * Attempts a state-machine transition. Returns `true` if the transition
 * succeeded (entity was in an allowed `from` state), `false` if the current
 * state did not permit the transition. Never throws for a guard failure —
 * only throws on unexpected DB errors.
 *
 * @param params - Runtime values for `'param:x'` placeholders in `where` and `set`.
 * @returns `true` if the transition was applied, `false` if the guard blocked it.
 */
export type TransitionBooleanMethod = (params: Record<string, unknown>) => Promise<boolean>;

/**
 * Resolved method for a {@link TransitionOpConfig} without `returns: 'boolean'`.
 *
 * Attempts a state-machine transition and returns the updated entity on
 * success, or `null` if the guard blocked it (entity was not in an allowed
 * `from` state).
 *
 * @template Entity - The entity type returned on success.
 * @param params - Runtime values for `'param:x'` placeholders in `where` and `set`.
 * @returns The updated entity after transition, or `null` if the guard blocked it.
 */
export type TransitionEntityMethod<Entity> = (
  params: Record<string, unknown>,
) => Promise<Entity | null>;

/**
 * Resolved method for a {@link FieldUpdateOpConfig}.
 *
 * Applies a partial update to an existing entity. The `params` object
 * supplies filter values (which entity to update), while `input` supplies
 * the new field values. The full updated entity is returned.
 *
 * @template Entity - The entity type returned after the update.
 * @param params - Runtime values for `'param:x'` placeholders in `where`.
 * @param input - Field values to write. Only fields declared in the op config
 *   are accepted — extra keys are ignored.
 * @returns The entity in its updated state.
 * @throws If no entity matches the `where` clause (behavior is backend-dependent;
 *   Mongo/Postgres throw, memory adapter returns the input unchanged).
 */
export type FieldUpdateMethod<Entity> = (
  params: Record<string, unknown>,
  input: Record<string, unknown>,
) => Promise<Entity>;

/**
 * Resolved method for an {@link AggregateOpConfig}.
 *
 * Computes a scalar value (count, sum, min, max, avg) over a filtered set of
 * entities. The return type is `unknown` at the type level because the
 * aggregate kind and field type determine the actual shape at runtime.
 *
 * @param params - Runtime values for `'param:x'` placeholders in `where`.
 * @returns The computed aggregate value (number for count/sum/min/max/avg).
 */
export type AggregateMethod = (params: Record<string, unknown>) => Promise<unknown>;

/**
 * Resolved method for a {@link ComputedAggregateOpConfig}.
 *
 * Reads a set of entities, runs user-supplied compute functions over them,
 * and writes the results back. Returns `void` — side-effects only.
 *
 * @param params - Runtime values for `'param:x'` placeholders in `where`.
 */
export type ComputedAggregateMethod = (params: Record<string, unknown>) => Promise<void>;

/**
 * Resolved method for a {@link BatchOpConfig}.
 *
 * Applies a bulk write (update or delete) to all entities matching the
 * filter. Returns the number of affected records.
 *
 * @param params - Runtime values for `'param:x'` placeholders in `where`.
 * @returns The count of entities that were updated or deleted.
 */
export type BatchMethod = (params: Record<string, unknown>) => Promise<number>;

/**
 * Resolved method for an {@link UpsertOpConfig} with `returns: { entity: true, created: true }`.
 *
 * Creates the entity if it doesn't exist, updates it if it does. Returns
 * both the entity and a `created` flag indicating which path was taken.
 *
 * @template Entity - The entity type.
 * @param input - Field values for the upsert. Identity fields determine
 *   whether a create or update occurs.
 * @returns `{ entity, created: true }` on insert, `{ entity, created: false }` on update.
 */
export type UpsertWithCreatedFlagMethod<Entity> = (
  input: Record<string, unknown>,
) => Promise<{ entity: Entity; created: boolean }>;

/**
 * Resolved method for an {@link UpsertOpConfig} without the `created` flag.
 *
 * Creates the entity if it doesn't exist, updates it if it does. Returns
 * only the final entity state, without indicating whether a create or update occurred.
 *
 * @template Entity - The entity type.
 * @param input - Field values for the upsert.
 * @returns The entity in its final (created or updated) state.
 */
export type UpsertMethod<Entity> = (input: Record<string, unknown>) => Promise<Entity>;

/**
 * Resolved method for a {@link SearchOpConfig} with `paginate: true`.
 *
 * Performs a full-text search against the configured search provider and
 * returns a cursor-paginated result. Requires a search plugin to be configured.
 *
 * @template Entity - The entity type in the paginated result.
 * @param query - The search query string.
 * @param filterParams - Optional runtime values for `'param:x'` filter placeholders.
 * @param limit - Maximum number of results per page.
 * @param cursor - Opaque pagination cursor from a previous page's `nextCursor`.
 * @returns A {@link PaginatedResult} of matched entities.
 */
export type SearchPaginatedMethod<Entity> = (
  query: string,
  filterParams?: Record<string, unknown>,
  limit?: number,
  cursor?: string,
) => Promise<PaginatedResult<Entity>>;

/**
 * Resolved method for a {@link SearchOpConfig} without `paginate: true`.
 *
 * Performs a full-text search and returns a flat array of matching entities.
 *
 * @template Entity - The entity type.
 * @param query - The search query string.
 * @param filterParams - Optional runtime values for filter placeholders.
 * @param limit - Maximum number of results to return.
 * @returns Array of matched entities, ordered by relevance score.
 */
export type SearchArrayMethod<Entity> = (
  query: string,
  filterParams?: Record<string, unknown>,
  limit?: number,
) => Promise<Entity[]>;

/**
 * Resolved method for a {@link ConsumeOpConfig} with `returns: 'boolean'`.
 *
 * Atomically finds an entity matching the filter and deletes it in a single
 * operation. Returns `true` if an entity was found and consumed, `false` if
 * none matched.
 *
 * @param params - Runtime values for `'param:x'` placeholders in `where`.
 * @returns `true` if an entity was consumed, `false` if none matched.
 */
export type ConsumeBooleanMethod = (params: Record<string, unknown>) => Promise<boolean>;

/**
 * Resolved method for a {@link ConsumeOpConfig} without `returns: 'boolean'`.
 *
 * Atomically finds an entity matching the filter, deletes it, and returns it.
 * Returns `null` if no entity matched.
 *
 * @template Entity - The entity type returned on success.
 * @param params - Runtime values for `'param:x'` placeholders in `where`.
 * @returns The consumed entity, or `null` if none matched.
 */
export type ConsumeEntityMethod<Entity> = (
  params: Record<string, unknown>,
) => Promise<Entity | null>;

/**
 * Resolved method for a {@link DeriveOpConfig}.
 *
 * Queries one or more source entities and merges their fields into a new
 * virtual object according to the configured merge strategy. Useful for
 * aggregating data from multiple related entities without creating a
 * permanent denormalized record.
 *
 * @param params - Runtime values for `'param:x'` placeholders across all source queries.
 * @returns Array of merged derived objects. Shape matches the configured merge strategy output.
 */
export type DeriveMethod = (params: Record<string, unknown>) => Promise<unknown[]>;

/**
 * Resolved method for a {@link TransactionOpConfig}.
 *
 * Executes a sequence of named steps in order. Each step's result is
 * available to subsequent steps via `'result:stepName.field'` references.
 * Returns all step results as an array.
 *
 * @param params - Runtime values for `'param:x'` placeholders across all steps.
 * @returns Array of step result objects, one per step in declaration order.
 */
export type TransactionMethod = (
  params: Record<string, unknown>,
) => Promise<Array<Record<string, unknown>>>;

/**
 * Resolved method for a {@link PipeOpConfig}.
 *
 * Executes a sequence of operations in order, threading the output of each
 * step as input to the next. The final step's output is returned.
 *
 * @param params - Runtime values for `'param:x'` placeholders used across steps.
 * @returns The output of the final step in the pipe.
 */
export type PipeMethod = (params: Record<string, unknown>) => Promise<unknown>;

/**
 * Resolved method for a {@link CollectionOpConfig}.
 *
 * Manages an embedded sub-document array on a parent entity. Exposes five
 * sub-operations as properties on a single object.
 *
 * @example
 * ```ts
 * // Given: ops.tags is a CollectionMethod
 * await ops.tags.list(parentId);
 * await ops.tags.add(parentId, { label: 'important' });
 * await ops.tags.remove(parentId, 'important');
 * await ops.tags.update(parentId, 'important', { label: 'critical' });
 * await ops.tags.set(parentId, [{ label: 'a' }, { label: 'b' }]);
 * ```
 */
export type CollectionMethod = {
  /**
   * List all items in the embedded collection for a given parent.
   * @param parentId - The primary key of the parent entity.
   */
  list: (parentId: string | number) => Promise<Array<Record<string, unknown>>>;
  /**
   * Append a new item to the embedded collection.
   * @param parentId - The primary key of the parent entity.
   * @param item - The item to add.
   */
  add: (
    parentId: string | number,
    item: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  /**
   * Remove an item from the collection by its identity value.
   * @param parentId - The primary key of the parent entity.
   * @param identifyValue - The value of the collection item's identity field.
   */
  remove: (parentId: string | number, identifyValue: unknown) => Promise<void>;
  /**
   * Update a specific item in the collection.
   * @param parentId - The primary key of the parent entity.
   * @param identifyValue - The identity value of the item to update.
   * @param updates - Fields to update on the matching item.
   */
  update: (
    parentId: string | number,
    identifyValue: unknown,
    updates: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  /**
   * Replace the entire embedded collection with a new array of items.
   * @param parentId - The primary key of the parent entity.
   * @param items - The complete replacement array.
   */
  set: (parentId: string | number, items: Array<Record<string, unknown>>) => Promise<void>;
};

/**
 * Resolved method for an {@link ArrayPushOpConfig}.
 *
 * Appends a value to an array field on an existing entity. Returns the full
 * updated entity.
 *
 * @param id - The primary key of the entity to update.
 * @param value - The value to push onto the array field.
 * @returns The entity with the updated array field.
 */
export type ArrayPushMethod = (
  id: string | number,
  value: unknown,
) => Promise<Record<string, unknown>>;

/**
 * Resolved method for an {@link ArrayPullOpConfig}.
 *
 * Removes a value from an array field on an existing entity. Returns the full
 * updated entity.
 *
 * @param id - The primary key of the entity to update.
 * @param value - The value to remove from the array field.
 * @returns The entity with the updated array field.
 */
export type ArrayPullMethod = (
  id: string | number,
  value: unknown,
) => Promise<Record<string, unknown>>;

/**
 * Resolved method for an {@link ArraySetOpConfig}.
 *
 * Replaces the entire array field on an existing entity with the provided array.
 * With `dedupe: true` (the default), the value is deduplicated server-side before
 * writing — equivalent to `[...new Set(newArray)]`.
 *
 * @param id - The primary key of the entity to update.
 * @param value - The replacement array. Must be an array; non-array values throw.
 * @returns The entity with the updated array field.
 * @throws If the entity is not found.
 * @throws If `value` is not an array.
 */
export type ArraySetMethod = (
  id: string | number,
  value: unknown[],
) => Promise<Record<string, unknown>>;

/**
 * Resolved type for `op.increment` — atomically adds `by` (default `1`) to a
 * numeric field and returns the updated entity. Pass a negative `by` to decrement.
 *
 * @param id - Primary key of the entity to update.
 * @param by - Amount to add (negative to subtract). Defaults to `1`.
 * @returns The entity with the updated field value.
 * @throws If the entity is not found.
 */
export type IncrementMethod = (
  id: string | number,
  by?: number,
) => Promise<Record<string, unknown>>;

/**
 * The resolved result of pairing an entity config with its named operation configs.
 *
 * Produced by `op.define()` (in `slingshot-data`) and consumed by the executor and
 * codegen layers. The `operations` map is keyed by operation name (e.g. `'getByRoom'`).
 *
 * @template Ops - The operations record, inferred from `op.define()` call.
 */
export interface ResolvedOperations<
  Ops extends Record<string, OperationConfig> = Record<string, OperationConfig>,
> {
  /** The entity this operation set is bound to. */
  readonly entityConfig: ResolvedEntityConfig;
  /** Named operation configs. Keys become method names on the generated adapter. */
  readonly operations: Ops;
}

/**
 * Maps a single operation config type to its runtime callable method type.
 *
 * Each branch resolves to a named exported type (e.g. {@link LookupManyMethod},
 * {@link FieldUpdateMethod}) so that IDE hover tooltips show the named type and
 * its JSDoc rather than an anonymous inline function signature.
 *
 * @template Op - A single {@link OperationConfig} variant.
 * @template Entity - The entity type the operation operates on.
 */
type InferOperationMethod<Op extends OperationConfig, Entity> = Op extends LookupOpConfig
  ? Op['returns'] extends 'one'
    ? LookupOneMethod<Entity>
    : LookupManyMethod<Entity>
  : Op extends ExistsOpConfig
    ? ExistsMethod
    : Op extends TransitionOpConfig
      ? Op['returns'] extends 'boolean'
        ? TransitionBooleanMethod
        : TransitionEntityMethod<Entity>
      : Op extends FieldUpdateOpConfig
        ? FieldUpdateMethod<Entity>
        : Op extends AggregateOpConfig
          ? AggregateMethod
          : Op extends ComputedAggregateOpConfig
            ? ComputedAggregateMethod
            : Op extends BatchOpConfig
              ? BatchMethod
              : Op extends UpsertOpConfig
                ? Op['returns'] extends { entity: true; created: true }
                  ? UpsertWithCreatedFlagMethod<Entity>
                  : UpsertMethod<Entity>
                : Op extends SearchOpConfig
                  ? Op['paginate'] extends true
                    ? SearchPaginatedMethod<Entity>
                    : SearchArrayMethod<Entity>
                  : Op extends ConsumeOpConfig
                    ? Op['returns'] extends 'boolean'
                      ? ConsumeBooleanMethod
                      : ConsumeEntityMethod<Entity>
                    : Op extends DeriveOpConfig
                      ? DeriveMethod
                      : Op extends TransactionOpConfig
                        ? TransactionMethod
                        : Op extends PipeOpConfig
                          ? PipeMethod
                          : Op extends CollectionOpConfig
                            ? CollectionMethod
                            : Op extends ArrayPushOpConfig
                              ? ArrayPushMethod
                              : Op extends ArrayPullOpConfig
                                ? ArrayPullMethod
                                : Op extends ArraySetOpConfig
                                  ? ArraySetMethod
                                  : Op extends IncrementOpConfig
                                    ? IncrementMethod
                                    : Op extends CustomOpConfig<infer Fn>
                                      ? Fn
                                      : never;

/**
 * Infer the full set of operation methods for a record of operation configs.
 *
 * ```ts
 * type Ops = InferOperationMethods<typeof myOps, MyEntity>;
 * // { getByRoom: (params) => Promise<PaginatedResult<MyEntity>>; ... }
 * ```
 */
export type InferOperationMethods<Ops extends Record<string, OperationConfig>, Entity> = {
  [K in keyof Ops]: InferOperationMethod<Ops[K], Entity>;
};
