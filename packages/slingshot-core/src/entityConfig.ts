/**
 * Config-driven entity & repository generation.
 *
 * Plugin authors describe an entity's shape declaratively using the `field.*()` builder
 * API, then get generated TypeScript types, Zod schemas, adapter interfaces, and
 * backend-specific implementations from a single source of truth.
 *
 * ```ts
 * import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
 *
 * export const Message = defineEntity('Message', {
 *   namespace: 'chat',
 *   fields: {
 *     id:        field.string({ primary: true, default: 'uuid' }),
 *     roomId:    field.string(),
 *     authorId:  field.string(),
 *     content:   field.string(),
 *     type:      field.enum(['text', 'image', 'system'], { default: 'text' }),
 *     metadata:  field.json({ optional: true }),
 *     createdAt: field.date({ default: 'now' }),
 *     updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
 *   },
 *   softDelete: { field: 'status', value: 'deleted' },
 *   defaultSort: { field: 'createdAt', direction: 'desc' },
 *   pagination: { cursor: { fields: ['createdAt', 'id'] }, defaultLimit: 50, maxLimit: 200 },
 *   indexes: [
 *     index(['roomId', 'createdAt'], { direction: 'desc' }),
 *     index(['authorId', 'createdAt'], { direction: 'desc' }),
 *   ],
 * });
 * ```
 */

// ============================================================================
// Field type tokens
// ============================================================================

/**
 * All supported field type tokens for use with `field.*()` builders.
 *
 * Each token maps to a TypeScript type via `FieldTypeMap` and controls how
 * adapters store and serialise field values for each backing store.
 */
export type FieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'enum'
  | 'json'
  | 'string[]';

/**
 * Maps `FieldType` tokens to their corresponding TypeScript types.
 *
 * Used by `InferEntity`, `InferCreateInput`, and `InferUpdateInput` to derive
 * entity types from field definitions without repetition.
 */
export interface FieldTypeMap {
  string: string;
  number: number;
  integer: number;
  boolean: boolean;
  /**
   * Date/time field — represented as an ISO-8601 string at the TypeScript layer.
   *
   * All persistence backends (Postgres, SQLite, Mongo, Redis, memory) serialise
   * dates to ISO-8601 strings before returning records, so `string` is the
   * correct runtime type. Use `new Date(value)` when a `Date` object is needed.
   */
  date: string;
  enum: string; // union narrowed by enumValues
  json: unknown;
  'string[]': string[];
}

// ============================================================================
// Field definition
// ============================================================================

/**
 * Auto-default sentinel values for field creation.
 *
 * - `'uuid'`  — generates a UUID v4 string
 * - `'now'`   — sets the field to the current timestamp at creation (or update when combined with `onUpdate`)
 * - `'cuid'`  — generates a CUID string (shorter and URL-safe alternative to UUID)
 */
export type AutoDefault = 'uuid' | 'now' | 'cuid';

/**
 * Options shared by all `field.*()` builders.
 *
 * Control optional/required status, default values, immutability, and primary key designation.
 */
export interface FieldOptions {
  /** Makes the field optional (TS `?:`). Defaults to `false`. */
  optional?: boolean;
  /** Default value: an auto sentinel or a literal matching the field type. */
  default?: string | number | boolean;
  /** Auto-set on every update (currently only `'now'` for date fields). */
  onUpdate?: 'now';
  /** Mark as the primary key. Exactly one field per entity. */
  primary?: boolean;
  /** Cannot be changed after creation (excluded from UpdateInput). */
  immutable?: boolean;
}

/**
 * Resolved field definition — the normalised shape stored in `EntityConfig.fields`.
 *
 * Created by the `field.*()` builders. Plugins should treat this as opaque.
 *
 * Generic parameters preserve literal types for precise `InferCreateInput` narrowing:
 * - `T` — the `FieldType` token
 * - `IsOptional` — `true` or `false` literal
 * - `Default` — the exact default value type (e.g. `'uuid'`, `'now'`, `'member'`, `undefined`)
 * - `OnUpdate` — `'now'` or `undefined`
 *
 * All parameters have wide defaults so existing `FieldDef` usages without type params
 * continue to compile without changes.
 */
export interface FieldDef<
  T extends FieldType = FieldType,
  IsOptional extends boolean = boolean,
  Default extends string | number | boolean | undefined = string | number | boolean | undefined,
  OnUpdate extends 'now' | undefined = 'now' | undefined,
  EnumValues extends readonly string[] = readonly string[],
> {
  readonly type: T;
  readonly optional: IsOptional;
  readonly primary: boolean;
  readonly immutable: boolean;
  readonly default?: Default;
  readonly onUpdate?: OnUpdate;
  readonly enumValues?: EnumValues;
}

// ============================================================================
// Private helpers: resolve FieldOptions to literal types for FieldDef generics
// ============================================================================

// These allow field builders to return precise FieldDef subtypes instead of the wide base type.

type ResolveOpt<O> = O extends { optional: true }
  ? true
  : O extends undefined
    ? false
    : O extends { optional?: false | undefined }
      ? false
      : boolean;

type ResolveDflt<O> = O extends { default: infer D extends string | number | boolean }
  ? D
  : undefined;

type ResolveUpd<O> = O extends { onUpdate: 'now' } ? 'now' : undefined;

// ============================================================================
// field.*() builder API
// ============================================================================

function makeField<
  T extends FieldType,
  O extends FieldOptions | undefined = undefined,
  EV extends readonly string[] = readonly string[],
>(
  type: T,
  opts?: O,
  enumValues?: EV,
): FieldDef<T, ResolveOpt<O>, ResolveDflt<O>, ResolveUpd<O>, EV> {
  const field: FieldDef<T, ResolveOpt<O>, ResolveDflt<O>, ResolveUpd<O>, EV> = {
    type,
    optional: (opts?.optional ?? false) as ResolveOpt<O>,
    primary: opts?.primary ?? false,
    immutable: opts?.immutable ?? opts?.primary ?? false, // PK is immutable by default
    default: opts?.default as ResolveDflt<O>,
    onUpdate: opts?.onUpdate as ResolveUpd<O>,
    enumValues,
  };
  return field;
}

/**
 * The `field` builder namespace — the only way to create `FieldDef` values for use
 * in `EntityConfig.fields`.
 *
 * Each method returns a typed `FieldDef` with sensible defaults. Pass `FieldOptions`
 * to control optionality, defaults, immutability, and primary key status.
 *
 * @example
 * ```ts
 * import { field } from '@lastshotlabs/slingshot-core';
 *
 * const fields = {
 *   id:        field.string({ primary: true, default: 'uuid' }),
 *   name:      field.string(),
 *   score:     field.number({ optional: true }),
 *   status:    field.enum(['active', 'deleted'], { default: 'active' }),
 *   createdAt: field.date({ default: 'now' }),
 * };
 * ```
 */
export const field = {
  /**
   * Variable-length text field.
   *
   * Maps to `VARCHAR` / `TEXT` in SQL backends, `String` in Mongo, and a plain string
   * in the memory/Redis adapters. Use `{ primary: true, default: 'uuid' }` for ID fields
   * and `{ default: 'cuid' }` for shorter URL-safe IDs.
   *
   * @param opts - Optional field options (optional, default, immutable, primary).
   * @returns A frozen `FieldDef<'string'>`.
   *
   * @remarks
   * The returned `FieldDef` is plain data — it is not frozen by this call but will be
   * deep-frozen when passed to `defineEntity()`. Mutations after `defineEntity()` returns
   * are silently ignored in non-strict mode and throw in strict mode.
   *
   * When `default` is `'uuid'` or `'cuid'`, the adapter generates the value at `create`
   * time. Explicit values passed in `CreateInput` take precedence over the auto-default,
   * but the field is excluded from the required portion of `InferCreateInput` since a value
   * is always guaranteed.
   *
   * @example
   * ```ts
   * const Post = defineEntity('Post', {
   *   fields: {
   *     id:    field.string({ primary: true, default: 'uuid' }),
   *     title: field.string(),
   *     slug:  field.string({ immutable: true }),
   *   },
   * });
   * ```
   */
  string: <O extends FieldOptions | undefined = undefined>(
    opts?: O,
  ): FieldDef<'string', ResolveOpt<O>, ResolveDflt<O>, ResolveUpd<O>> => makeField('string', opts),

  /**
   * Floating-point number field.
   *
   * Maps to `REAL` / `DOUBLE PRECISION` in SQL, `Number` in Mongo, and a JS number in
   * memory/Redis adapters. Use for monetary amounts (as cents integer instead), scores,
   * coordinates, or any non-integer numeric value.
   *
   * @param opts - Optional field options (optional, default, immutable, primary).
   * @returns A frozen `FieldDef<'number'>`.
   *
   * @remarks
   * SQLite stores all numbers as IEEE 754 doubles. If you need exact integer semantics
   * (e.g. row counts, foreign key IDs) prefer `field.integer()` instead.
   *
   * @example
   * ```ts
   * const Product = defineEntity('Product', {
   *   fields: {
   *     id:    field.string({ primary: true, default: 'uuid' }),
   *     score: field.number({ default: 0 }),
   *     lat:   field.number({ optional: true }),
   *     lng:   field.number({ optional: true }),
   *   },
   * });
   * ```
   */
  number: <O extends FieldOptions | undefined = undefined>(
    opts?: O,
  ): FieldDef<'number', ResolveOpt<O>, ResolveDflt<O>, ResolveUpd<O>> => makeField('number', opts),

  /**
   * Integer field.
   *
   * Maps to `INTEGER` in SQLite/Postgres, `Number` in Mongo, and a JS number in
   * memory/Redis adapters. Suitable for counters, sequence IDs, or any whole-number value.
   *
   * @param opts - Optional field options (optional, default, immutable, primary).
   * @returns A frozen `FieldDef<'integer'>`.
   *
   * @remarks
   * When used as a primary key (`primary: true`), the adapter layer is responsible for
   * auto-incrementing if no default is specified. Unlike `'string'` primary keys, `'integer'`
   * PKs do not support the `'uuid'` or `'cuid'` auto-defaults — omit `default` and let the
   * backing store assign the sequence value.
   *
   * @example
   * ```ts
   * const Counter = defineEntity('Counter', {
   *   fields: {
   *     id:    field.integer({ primary: true }),
   *     count: field.integer({ default: 0 }),
   *   },
   * });
   * ```
   */
  integer: <O extends FieldOptions | undefined = undefined>(
    opts?: O,
  ): FieldDef<'integer', ResolveOpt<O>, ResolveDflt<O>, ResolveUpd<O>> =>
    makeField('integer', opts),

  /**
   * Boolean flag field.
   *
   * Maps to `BOOLEAN` in Postgres, `INTEGER` (0/1) in SQLite, `Boolean` in Mongo,
   * and a JS boolean serialised as `'true'`/`'false'` in Redis.
   *
   * @param opts - Optional field options (optional, default, immutable, primary).
   * @returns A frozen `FieldDef<'boolean'>`.
   *
   * @remarks
   * Defaults are specified as a literal boolean (`default: false`), not a string sentinel.
   * Boolean fields cannot use the `'uuid'`, `'now'`, or `'cuid'` auto-defaults.
   *
   * @example
   * ```ts
   * const User = defineEntity('User', {
   *   fields: {
   *     id:        field.string({ primary: true, default: 'uuid' }),
   *     isActive:  field.boolean({ default: true }),
   *     isBanned:  field.boolean({ default: false }),
   *   },
   * });
   * ```
   */
  boolean: <O extends FieldOptions | undefined = undefined>(
    opts?: O,
  ): FieldDef<'boolean', ResolveOpt<O>, ResolveDflt<O>, ResolveUpd<O>> =>
    makeField('boolean', opts),

  /**
   * Date/time field.
   *
   * Stored as epoch milliseconds in SQLite, a native `Date`/`ISODate` in Mongo/Postgres,
   * and as an ISO 8601 string in Redis and the memory adapter.
   *
   * Use `{ default: 'now' }` to stamp the creation time automatically and
   * `{ default: 'now', onUpdate: 'now' }` to also refresh on every update.
   *
   * @param opts - Optional field options (optional, default, onUpdate, immutable, primary).
   * @returns A frozen `FieldDef<'date'>`.
   *
   * @remarks
   * Fields with `onUpdate: 'now'` are excluded from `InferCreateInput` and `InferUpdateInput`
   * because they are always managed by the adapter — consumers never pass them explicitly.
   *
   * Fields with `default: 'now'` are excluded from the _required_ portion of `InferCreateInput`
   * (they have a guaranteed value) but can still be overridden by passing an explicit value.
   *
   * @example
   * ```ts
   * const Post = defineEntity('Post', {
   *   fields: {
   *     id:        field.string({ primary: true, default: 'uuid' }),
   *     title:     field.string(),
   *     publishAt: field.date({ optional: true }),
   *     createdAt: field.date({ default: 'now' }),
   *     updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
   *   },
   * });
   * ```
   */
  date: <O extends FieldOptions | undefined = undefined>(
    opts?: O,
  ): FieldDef<'date', ResolveOpt<O>, ResolveDflt<O>, ResolveUpd<O>> => makeField('date', opts),

  /**
   * Constrained string enum field.
   *
   * The first argument is a `readonly` tuple of allowed string values. The TypeScript type
   * is narrowed to a union of those literals via `FieldTypeMap['enum']` and `enumValues`.
   * Adapters validate or constrain the stored value to one of the declared options.
   *
   * @param values - The exhaustive list of allowed string values. Must be non-empty.
   * @param opts - Optional field options (optional, default, immutable, primary).
   * @returns A frozen `FieldDef<'enum'>` with `enumValues` set.
   *
   * @remarks
   * Pass `default` as one of the literal strings in `values` — using any other string
   * is a type error. The `default` value does not need to appear first in the array.
   * The code generator uses `enumValues` to produce a Zod `z.enum()` and a TypeScript
   * union type, so every value you declare here becomes a valid literal in generated code.
   *
   * @example
   * ```ts
   * const Task = defineEntity('Task', {
   *   fields: {
   *     id:     field.string({ primary: true, default: 'uuid' }),
   *     status: field.enum(['pending', 'active', 'done', 'cancelled'], { default: 'pending' }),
   *     role:   field.enum(['viewer', 'editor', 'admin'] as const, { default: 'viewer' }),
   *   },
   * });
   * ```
   */
  enum: <const V extends readonly string[], O extends FieldOptions | undefined = undefined>(
    values: V,
    opts?: O,
  ): FieldDef<'enum', ResolveOpt<O>, ResolveDflt<O>, ResolveUpd<O>, V> =>
    makeField('enum', opts, values),

  /**
   * Flexible JSON blob field.
   *
   * Stored as `JSONB` in Postgres, `JSON` text in SQLite, a native `Mixed` / sub-document
   * in Mongo, and a JSON-serialised string in Redis and the memory adapter.
   *
   * The TypeScript type is `unknown` — validate the shape at the application layer using
   * Zod or another schema library before using the value.
   *
   * @param opts - Optional field options (optional, default, immutable, primary).
   * @returns A frozen `FieldDef<'json'>`.
   *
   * @remarks
   * `json` fields are always marked `optional: true` in practice because an absent JSON
   * blob is semantically distinct from an empty object. The code generator emits no Zod
   * constraints on the shape — add runtime validation in operation handlers or use a
   * typed wrapper in the domain layer.
   *
   * @example
   * ```ts
   * const Event = defineEntity('Event', {
   *   fields: {
   *     id:       field.string({ primary: true, default: 'uuid' }),
   *     metadata: field.json({ optional: true }),
   *     payload:  field.json(),
   *   },
   * });
   * ```
   */
  json: <O extends FieldOptions | undefined = undefined>(
    opts?: O,
  ): FieldDef<'json', ResolveOpt<O>, ResolveDflt<O>, ResolveUpd<O>> => makeField('json', opts),

  /**
   * Array of strings field.
   *
   * Stored as `TEXT[]` in Postgres, a JSON-encoded array in SQLite, a native array in Mongo,
   * and a JSON-serialised string in Redis and the memory adapter. TypeScript type is
   * `string[]`.
   *
   * @param opts - Optional field options (optional, default, immutable, primary).
   * @returns A frozen `FieldDef<'string[]'>`.
   *
   * @remarks
   * Filtering by array membership (e.g., "records where `tags` contains `'typescript'`")
   * depends on adapter support. Check the specific adapter's filter documentation before
   * relying on array-containment queries across all backends.
   *
   * `string[]` fields cannot use auto-default sentinels (`'uuid'`, `'now'`, `'cuid'`).
   * To default to an empty array, omit the field from `CreateInput` and let the adapter
   * set a default, or pass `[]` explicitly.
   *
   * @example
   * ```ts
   * const Article = defineEntity('Article', {
   *   fields: {
   *     id:   field.string({ primary: true, default: 'uuid' }),
   *     tags: field.stringArray({ optional: true }),
   *   },
   * });
   * ```
   */
  stringArray: <O extends FieldOptions | undefined = undefined>(
    opts?: O,
  ): FieldDef<'string[]', ResolveOpt<O>, ResolveDflt<O>, ResolveUpd<O>> =>
    makeField('string[]', opts),
} as const;

// ============================================================================
// Index definition
// ============================================================================

/**
 * A compound index definition for an entity.
 *
 * Created via the `index()` helper and listed in `EntityConfig.indexes`.
 * Adapters use these definitions to create backing store indexes at startup.
 */
export interface IndexDef {
  readonly fields: readonly string[];
  readonly direction?: 'asc' | 'desc';
  readonly unique?: boolean;
}

/**
 * Convenience builder for compound indexes.
 *
 * @param fields - Entity field names to include in the index (in order).
 * @param opts - Optional direction and uniqueness constraints.
 * @returns An `IndexDef` for use in `EntityConfig.indexes`.
 *
 * @example
 * ```ts
 * import { index } from '@lastshotlabs/slingshot-core';
 *
 * const indexes = [
 *   index(['roomId', 'createdAt'], { direction: 'desc' }),
 *   index(['email'], { unique: true }),
 * ];
 * ```
 */
export function index(
  fields: string[],
  opts?: { direction?: 'asc' | 'desc'; unique?: boolean },
): IndexDef {
  return { fields, direction: opts?.direction, unique: opts?.unique };
}

// ============================================================================
// Relation definitions (informational — for type gen, not auto-joined)
// ============================================================================

/**
 * Informational relation metadata for an entity field.
 *
 * Relations are NOT automatically joined by adapters — they are metadata hints
 * for code generation, admin UIs, and schema documentation tools. Joins must
 * be done manually in operation configs (`op.derive`, `op.lookup`) or at the
 * application layer.
 */
export interface RelationDef {
  readonly kind: 'belongsTo' | 'hasMany' | 'hasOne';
  readonly target: string;
  readonly foreignKey: string;
  readonly optional?: boolean;
}

/**
 * The `relation` builder namespace — creates informational `RelationDef` values for use
 * in `EntityConfig.relations`.
 *
 * Relations are metadata only — they inform code generators and admin tools but do NOT
 * cause automatic joins in adapters.
 *
 * @example
 * ```ts
 * import { relation } from '@lastshotlabs/slingshot-core';
 *
 * const relations = {
 *   author: relation.belongsTo('User', 'authorId'),
 *   comments: relation.hasMany('Comment', 'postId'),
 * };
 * ```
 */
export const relation = {
  belongsTo: (target: string, foreignKey: string, opts?: { optional?: boolean }): RelationDef => ({
    kind: 'belongsTo',
    target,
    foreignKey,
    optional: opts?.optional,
  }),
  hasMany: (target: string, foreignKey: string): RelationDef => ({
    kind: 'hasMany',
    target,
    foreignKey,
  }),
  hasOne: (target: string, foreignKey: string): RelationDef => ({
    kind: 'hasOne',
    target,
    foreignKey,
  }),
} as const;

// ============================================================================
// Soft delete configuration
// ============================================================================

/**
 * Soft-delete configuration for an entity.
 *
 * When set, delete operations update a field instead of removing the record.
 * Two strategies are supported:
 * - `{ field, value }` — sets the field to a specific value (e.g., `status: 'deleted'`)
 * - `{ field, strategy: 'non-null' }` — sets a nullable field to a non-null timestamp
 *
 * Soft-deleted records are excluded from `list` and `getById` queries by default.
 */
export type SoftDeleteConfig =
  | {
      /** The field that tracks deletion status. */
      readonly field: string;
      /** The value that marks a record as deleted. */
      readonly value: string;
    }
  | {
      /** The field that tracks deletion status (date field set to non-null on delete). */
      readonly field: string;
      /** Strategy: record is deleted when the field is non-null. */
      readonly strategy: 'non-null';
    };

// ============================================================================
// Pagination configuration
// ============================================================================

/**
 * Cursor pagination configuration for an entity's `list` operation.
 *
 * `cursor.fields` are the tie-breaking fields used to construct stable, opaque cursors.
 * Typically `['createdAt', 'id']` for stable time-ordered pagination.
 */
export interface PaginationConfig {
  /** Cursor fields for tie-breaking. */
  readonly cursor: { readonly fields: readonly string[] };
  /** Default page size. */
  readonly defaultLimit?: number;
  /** Maximum allowed page size. */
  readonly maxLimit?: number;
}

// ============================================================================
// Tenant configuration
// ============================================================================

/**
 * Multi-tenant scoping configuration for an entity.
 *
 * When set, the framework ensures that all queries are automatically scoped
 * to the current tenant context. The `field` must exist in `EntityConfig.fields`
 * and should be of type `'string'`.
 */
export interface TenantConfig {
  /** The field holding the tenant ID. */
  readonly field: string;
  /** Whether tenancy is optional (not all deployments use it). */
  readonly optional?: boolean;
}

// ============================================================================
// Storage hints (per-backend overrides)
// ============================================================================

/**
 * Per-backend storage configuration overrides for an entity.
 *
 * Use these to customise table/collection names and other backend-specific settings
 * without changing the entity's canonical `name` or `namespace`.
 */
export interface EntityStorageHints {
  memory?: { maxEntries?: number };
  redis?: { keyPrefix?: string };
  sqlite?: { tableName?: string };
  mongo?: { collectionName?: string };
  postgres?: { tableName?: string };
}

// ============================================================================
// Entity TTL (optional expiration)
// ============================================================================

/**
 * Optional TTL (time-to-live) for entity records.
 *
 * When set, adapters that support TTL-based expiry (Redis, memory) will
 * automatically expire records after `defaultSeconds`. SQL adapters that
 * don't support native TTL must implement periodic cleanup separately.
 */
export interface EntityTtlConfig {
  /** Default TTL in seconds for every record. */
  readonly defaultSeconds: number;
}

// ============================================================================
// Search configuration
// ============================================================================

/** Per-field search configuration. Controls how a field participates in search operations. */
export interface SearchFieldConfig {
  /** Include in full-text search. Default true. */
  readonly searchable?: boolean;
  /** Relevance weight/boost. Higher = more important. Default 1. */
  readonly weight?: number;
  /** Allow filtering (equality, range, IN). Default false. */
  readonly filterable?: boolean;
  /** Allow sorting. Default false. */
  readonly sortable?: boolean;
  /** Include in facet distributions. Default false. */
  readonly facetable?: boolean;
  /** Include in search results. Default true. */
  readonly displayed?: boolean;
  /** Disable typo tolerance for this field. */
  readonly noTypoTolerance?: boolean;
}

/** Geo search configuration. Both fields must be `number` type. */
export interface GeoSearchConfig {
  readonly latField: string;
  readonly lngField: string;
  /** Auto-add geo fields to filterable set. Default true. */
  readonly autoFilter?: boolean;
}

/**
 * Entity-level search configuration.
 *
 * Declares what's searchable on an entity. The search plugin provides the engine;
 * the entity declares which fields participate, how they're weighted, and what
 * sync strategy to use.
 */
export interface EntitySearchConfig {
  /** Named provider to use. References a key in the search plugin's providers map. Default 'default'. */
  readonly provider?: string;

  /** Field-level search configuration. Keys must reference fields in the entity's `fields`. */
  readonly fields: Record<string, SearchFieldConfig>;

  /** Geo search configuration. */
  readonly geo?: GeoSearchConfig;

  /**
   * Document sync strategy:
   * - 'write-through': sync on every create/update/delete (default)
   * - 'event-bus': async via SlingshotEventBus (eventual consistency)
   * - 'manual': no automatic sync
   */
  readonly syncMode?: 'write-through' | 'event-bus' | 'manual';

  /**
   * Named document transformer. Resolved through the search handler registry at runtime.
   * Runs before indexing to flatten relations, compute derived fields, etc.
   * A string reference, not a function — config stays JSON-serializable.
   */
  readonly transform?: string;

  /** Override index name (defaults to entity _storageName). */
  readonly indexName?: string;

  /** Distinct/de-duplication field. Must exist in entity fields. */
  readonly distinctField?: string;

  /**
   * Tenant isolation mode:
   * - 'filtered': injects a tenant filter on every query (shared index)
   * - 'index-per-tenant': creates a separate index per tenant
   */
  readonly tenantIsolation?: 'filtered' | 'index-per-tenant';

  /** Entity field holding the tenant identifier. Used when tenantIsolation is set. */
  readonly tenantField?: string;
}

// ============================================================================
// EntityConfig — the complete entity definition
// ============================================================================

/**
 * The complete entity definition — the single source of truth for an entity's schema,
 * persistence, and route/channel configuration.
 *
 * Pass this to `defineEntity()` which validates it and derives `_pkField` and `_storageName`.
 * The resolved result is deep-frozen and registered with the entity registry.
 *
 * @template F - The fields record type, inferred from the `fields` object you pass.
 */
export interface EntityConfig<F extends Record<string, FieldDef> = Record<string, FieldDef>> {
  /** Entity name (PascalCase). */
  readonly name: string;
  /** Plugin namespace — prefixes table/collection names (e.g., 'chat'). */
  readonly namespace?: string;
  /** Field definitions built with `field.*()`. */
  readonly fields: F;
  /** Soft-delete configuration. */
  readonly softDelete?: SoftDeleteConfig;
  /** Default sort for list operations. */
  readonly defaultSort?: { readonly field: string; readonly direction: 'asc' | 'desc' };
  /** Cursor pagination config. */
  readonly pagination?: PaginationConfig;
  /** Compound indexes. */
  readonly indexes?: readonly IndexDef[];
  /** Unique constraints. */
  readonly uniques?: readonly { readonly fields: readonly string[]; readonly upsert?: boolean }[];
  /** Relation metadata (informational for type generation). */
  readonly relations?: Record<string, RelationDef>;
  /** Multi-tenant scoping. */
  readonly tenant?: TenantConfig;
  /** Optional record TTL. */
  readonly ttl?: EntityTtlConfig;
  /** Per-backend storage overrides. */
  readonly storage?: EntityStorageHints;
  /** Search engine configuration. Declares searchable fields, sync strategy, etc. */
  readonly search?: EntitySearchConfig;
  /** Declarative route configuration. When set, route generation includes auth,
   *  permissions, rate limits, events, and middleware. */
  readonly routes?: import('./entityRouteConfig').EntityRouteConfig;
  /** Consumer-configurable system field name overrides. */
  readonly systemFields?: EntitySystemFields;
  /** Storage-level field name overrides for backend adapters. */
  readonly storageFields?: EntityStorageFieldMap;
  /** Storage convention overrides (Redis key format, custom ID/default generators, etc.). */
  readonly conventions?: EntityStorageConventions;
}

// ============================================================================
// Type-level inference helpers
// ============================================================================

/**
 * Infer the full entity type from a fields record.
 *
 * Required fields (not marked `optional: true`) become required TypeScript properties.
 * Optional fields (`optional: true`) become optional TypeScript properties (`?:`).
 *
 * @example
 * ```ts
 * import type { InferEntity } from '@lastshotlabs/slingshot-core';
 * import { Post } from './post.entity';
 *
 * type Post = InferEntity<typeof Post.fields>;
 * // { id: string; title: string; content?: string; createdAt: Date }
 * ```
 */
type RequiredFieldNames<F extends Record<string, FieldDef>> = {
  [K in keyof F]: F[K]['optional'] extends true ? never : K;
}[keyof F];

type OptionalFieldNames<F extends Record<string, FieldDef>> = {
  [K in keyof F]: F[K]['optional'] extends true ? K : never;
}[keyof F];

/**
 * Resolve the TypeScript type for a single field, using the literal enum union
 * when the field carries narrowed `EnumValues`, falling back to `string` otherwise.
 */
export type InferFieldType<F extends FieldDef> =
  F extends FieldDef<
    'enum',
    boolean,
    string | number | boolean | undefined,
    'now' | undefined,
    infer V extends readonly string[]
  >
    ? string extends V[number]
      ? string
      : V[number]
    : FieldTypeMap[F['type']];

/** Infer the full entity type (all fields, respecting optional). */
export type InferEntity<F extends Record<string, FieldDef>> = {
  [K in RequiredFieldNames<F> & string]: InferFieldType<F[K]>;
} & {
  [K in OptionalFieldNames<F> & string]?: InferFieldType<F[K]> | null;
};

/**
 * Infer the CreateInput type from a fields record.
 *
 * Excludes fields that are auto-managed (auto defaults like `'uuid'`/`'now'`/`'cuid'`
 * and fields with `onUpdate`). Fields with explicit non-auto defaults are optional
 * in the input. Fields marked `optional: true` are also optional in the input.
 *
 * @example
 * ```ts
 * import type { InferCreateInput } from '@lastshotlabs/slingshot-core';
 * import { Post } from './post.entity';
 *
 * type CreatePost = InferCreateInput<typeof Post.fields>;
 * // id and createdAt excluded (auto); title required; content optional
 * ```
 */
// Uses Exclude<D, undefined> so that optional `default?` properties are handled correctly:
// - HasAutoDefault<'uuid' | undefined> → Exclude → 'uuid' → extends 'uuid'|'now'|'cuid' → true
// - HasAutoDefault<undefined>          → Exclude → never  → [never] extends [never] → false
// - HasAutoDefault<'member' | undefined> → Exclude → 'member' → not auto → false
type HasAutoDefault<D> = [Exclude<D, undefined>] extends [never]
  ? false
  : Exclude<D, undefined> extends 'uuid' | 'now' | 'cuid'
    ? true
    : false;

type ExcludedFromCreate<F extends FieldDef> =
  NonNullable<F['onUpdate']> extends 'now'
    ? true
    : HasAutoDefault<F['default']> extends true
      ? true
      : false;

type RequiredInCreate<F extends Record<string, FieldDef>> = {
  [K in keyof F]: ExcludedFromCreate<F[K]> extends true
    ? never
    : F[K]['optional'] extends true
      ? never
      : F[K]['default'] extends string | number | boolean
        ? never
        : K;
}[keyof F];

type OptionalInCreate<F extends Record<string, FieldDef>> = {
  [K in keyof F]: ExcludedFromCreate<F[K]> extends true
    ? never
    : F[K]['optional'] extends true
      ? K
      : F[K]['default'] extends string | number | boolean
        ? K
        : never;
}[keyof F];

export type InferCreateInput<F extends Record<string, FieldDef>> = {
  [K in RequiredInCreate<F> & string]: InferFieldType<F[K]>;
} & {
  [K in OptionalInCreate<F> & string]?: F[K]['optional'] extends true
    ? InferFieldType<F[K]> | null
    : InferFieldType<F[K]>;
};

/**
 * Infer the UpdateInput type from a fields record.
 *
 * Excludes immutable fields (including the primary key) and fields with `onUpdate`
 * (which are auto-managed). All remaining fields are optional, enabling partial
 * (patch-style) updates.
 *
 * @example
 * ```ts
 * import type { InferUpdateInput } from '@lastshotlabs/slingshot-core';
 * import { Post } from './post.entity';
 *
 * type UpdatePost = InferUpdateInput<typeof Post.fields>;
 * // { title?: string; content?: string } — id and timestamps excluded
 * ```
 */
type MutableFieldNames<F extends Record<string, FieldDef>> = {
  [K in keyof F]: F[K]['immutable'] extends true
    ? never
    : F[K]['onUpdate'] extends 'now'
      ? never
      : K;
}[keyof F];

export type InferUpdateInput<F extends Record<string, FieldDef>> = {
  [K in MutableFieldNames<F> & string]?: F[K]['optional'] extends true
    ? InferFieldType<F[K]> | null
    : InferFieldType<F[K]>;
};

// ============================================================================
// Cursor pagination types
// ============================================================================

/**
 * Options for cursor-paginated adapter list operations.
 *
 * Pass `cursor` from a previous `PaginatedResult.nextCursor` to fetch the next page.
 * Omit `cursor` to start from the beginning. Combine with `sortDir` to reverse traversal.
 */
export interface CursorPaginationOptions {
  /** Maximum records to return. */
  limit?: number;
  /** Opaque cursor from a previous response. */
  cursor?: string;
  /** Sort direction override. */
  sortDir?: 'asc' | 'desc';
}

/**
 * A page of results from a cursor-paginated adapter list operation.
 *
 * `nextCursor` is present when more records exist beyond this page.
 * Pass it back as `cursor` in the next call to advance the page.
 *
 * @template T - The entity type for each item in the page.
 */
export interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
}

// ============================================================================
// Generated adapter interface
// ============================================================================

/**
 * The typed adapter interface generated for an entity by `slingshot-data`.
 *
 * Provides CRUD operations with full type inference from the entity's field definitions.
 * The `create`, `update`, `delete`, and `list` methods handle soft-delete logic
 * transparently when the entity is configured with `softDelete`.
 *
 * @template Entity - The full entity type (from `InferEntity`).
 * @template CreateInput - The create input type (from `InferCreateInput`).
 * @template UpdateInput - The update input type (from `InferUpdateInput`).
 */
export interface EntityAdapter<Entity, CreateInput, UpdateInput> {
  /** Allow adapter implementations to carry extra keys (e.g. composite ops). */
  [key: string]: unknown;
  /** Insert a new record, applying auto-defaults. Returns the created entity. */
  create(input: CreateInput): Promise<Entity>;
  /** Retrieve by primary key. Returns `null` when not found (or out of scope). */
  getById(id: string | number, filter?: Record<string, unknown>): Promise<Entity | null>;
  /** Partial update by primary key. Returns the updated entity, or `null` if not found. */
  update(
    id: string | number,
    input: UpdateInput,
    filter?: Record<string, unknown>,
  ): Promise<Entity | null>;
  /** Delete by primary key. Returns `true` when a row was removed or soft-deleted. */
  delete(id: string | number, filter?: Record<string, unknown>): Promise<boolean>;
  /** List with optional filters and cursor pagination. */
  list(opts?: CursorPaginationOptions & Record<string, unknown>): Promise<PaginatedResult<Entity>>;
  /** Drop all records. Useful for tests and teardown. */
  clear(): Promise<void>;
}

// ============================================================================
// Entity system fields and storage field mapping
// ============================================================================

/**
 * Consumer-configurable system field names for an entity.
 *
 * Allows consumers to rename framework-assumed field names to match their
 * domain model. All fields have sensible defaults when omitted.
 *
 * @example
 * ```ts
 * const Order = defineEntity('Order', {
 *   systemFields: {
 *     createdBy: 'authorId',
 *     tenantField: 'organizationId',
 *   },
 *   fields: { ... },
 * });
 * ```
 */
export interface EntitySystemFields {
  /** Created-by field name. Default: `'createdBy'`. */
  readonly createdBy?: string;
  /** Updated-by field name. Default: `'updatedBy'`. */
  readonly updatedBy?: string;
  /** Owner field name for permission checks. Default: `'ownerId'`. */
  readonly ownerField?: string;
  /** Tenant scoping field name. Default: derived from `tenant.field` or `'tenantId'`. */
  readonly tenantField?: string;
  /** Version/concurrency field name. Default: `'version'`. */
  readonly version?: string;
}

/**
 * Storage-level field name overrides for backend adapters.
 *
 * These control how domain fields are mapped to physical storage fields.
 * All fields have sensible defaults when omitted.
 *
 * @example
 * ```ts
 * const Token = defineEntity('Token', {
 *   storageFields: {
 *     mongoPkField: '_tokenId',
 *     ttlField: 'expires_at',
 *   },
 *   fields: { ... },
 * });
 * ```
 */
export interface EntityStorageFieldMap {
  /** Mongo document primary key field. Default: `'_id'`. */
  readonly mongoPkField?: string;
  /** SQL/storage TTL expiry column name. Default: `'_expires_at'`. */
  readonly ttlField?: string;
  /** Mongo TTL expiry field name. Default: `'_expiresAt'`. */
  readonly mongoTtlField?: string;
}

/**
 * Resolved (defaulted) system fields attached to `ResolvedEntityConfig`.
 *
 * All fields are guaranteed non-null — defaults are applied at definition time
 * by `defineEntity()`. Adapters, route builders, and manifest helpers read
 * these resolved names instead of hardcoding first-party conventions.
 */
export interface ResolvedEntitySystemFields {
  /** Resolved created-by audit field name. */
  readonly createdBy: string;
  /** Resolved updated-by audit field name. */
  readonly updatedBy: string;
  /** Resolved owner field name for permission checks. */
  readonly ownerField: string;
  /** Resolved tenant scoping field name. */
  readonly tenantField: string;
  /** Resolved version/concurrency field name. */
  readonly version: string;
}

/**
 * Resolved (defaulted) storage field mapping attached to `ResolvedEntityConfig`.
 *
 * All fields are guaranteed non-null — defaults are applied at definition time
 * by `defineEntity()`. Backend adapters read these resolved names instead of
 * hardcoding storage-level field conventions.
 */
export interface ResolvedEntityStorageFieldMap {
  /** Resolved Mongo document primary key field name. */
  readonly mongoPkField: string;
  /** Resolved SQL/storage TTL expiry column name. */
  readonly ttlField: string;
  /** Resolved Mongo TTL expiry field name. */
  readonly mongoTtlField: string;
}

// ============================================================================
// Storage convention configuration
// ============================================================================

/**
 * Custom auto-default resolver function for entity field defaults.
 *
 * Extends the built-in `'uuid' | 'cuid' | 'now'` auto-default sentinels with
 * consumer-defined strategies. Called during record creation when a field's
 * `default` value is a string that does not match a built-in sentinel.
 *
 * Return the generated value to use it, or `undefined` to signal that the
 * sentinel is not recognized (which will throw an error).
 *
 * @param kind - The sentinel string from the field's `default` option.
 * @returns The generated default value, or `undefined` if unrecognized.
 *
 * @example
 * ```ts
 * import { ulid } from 'ulid';
 *
 * const customAutoDefault: CustomAutoDefaultResolver = (kind) => {
 *   if (kind === 'ulid') return ulid();
 *   if (kind === 'snowflake') return generateSnowflake();
 *   return undefined; // fall through to error for unknown sentinels
 * };
 * ```
 */
export type CustomAutoDefaultResolver = (kind: string) => unknown;

/**
 * Custom on-update resolver function for entity field update-time values.
 *
 * Extends the built-in `'now'` on-update sentinel with consumer-defined
 * strategies. Called during record updates when a field's `onUpdate` value
 * is a string that does not match `'now'`.
 *
 * Return the computed value to apply it, or `undefined` to skip the field.
 *
 * @param kind - The sentinel string from the field's `onUpdate` option.
 * @returns The computed update-time value, or `undefined` to skip.
 *
 * @example
 * ```ts
 * const customOnUpdate: CustomOnUpdateResolver = (kind) => {
 *   if (kind === 'increment') return 1; // adapter would add to existing
 *   if (kind === 'timestamp') return Date.now(); // epoch millis instead of Date
 *   return undefined;
 * };
 * ```
 */
export type CustomOnUpdateResolver = (kind: string) => unknown;

/**
 * Consumer-configurable storage convention overrides for an entity.
 *
 * Passed via `conventions` on `EntityConfig`. Allows consumers to customize
 * how records are keyed in Redis, how IDs are generated, and how fields are
 * updated without forking adapter code.
 *
 * All properties are optional. When omitted, the built-in defaults apply:
 * - **Redis key format**: `${storageName}:${appName}:${pk}`
 * - **ID generation**: `'uuid'`, `'cuid'`, `'now'` (built-in sentinels)
 * - **On-update**: `'now'` (built-in sentinel)
 *
 * @example
 * ```ts
 * import { defineEntity, field } from '@lastshotlabs/slingshot-entity';
 * import { ulid } from 'ulid';
 *
 * const Task = defineEntity('Task', {
 *   fields: {
 *     id: field.string({ primary: true, default: 'ulid' }),
 *     name: field.string(),
 *     updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
 *   },
 *   conventions: {
 *     redisKey: ({ appName, storageName, pk }) => `${appName}/${storageName}/${pk}`,
 *     autoDefault: (kind) => kind === 'ulid' ? ulid() : undefined,
 *   },
 * });
 * ```
 */
export interface EntityStorageConventions {
  /**
   * Custom Redis key format function.
   *
   * When provided, the Redis adapter calls this function to compute the key
   * for each record instead of using the default `${storageName}:${appName}:${pk}`
   * format. The same function is also called with `pk: '*'` to derive the scan
   * pattern for list/clear operations.
   *
   * @param args - Object containing `appName`, `storageName`, and `pk`.
   * @returns The Redis key string.
   */
  readonly redisKey?: (args: {
    appName: string;
    storageName: string;
    pk: string | number;
  }) => string;
  /**
   * Custom auto-default resolver for non-built-in sentinel values.
   *
   * Called during `applyDefaults()` when a field's `default` is a string
   * that is not one of `'uuid'`, `'cuid'`, or `'now'`.
   *
   * @see {@link CustomAutoDefaultResolver}
   */
  readonly autoDefault?: CustomAutoDefaultResolver;
  /**
   * Custom on-update resolver for non-built-in sentinel values.
   *
   * Called during `applyOnUpdate()` when a field's `onUpdate` is a string
   * that is not `'now'`.
   *
   * @see {@link CustomOnUpdateResolver}
   */
  readonly onUpdate?: CustomOnUpdateResolver;
}

/**
 * Resolved storage conventions attached to `ResolvedEntityConfig._conventions`.
 *
 * Mirrors {@link EntityStorageConventions} with the same optional shape.
 * `undefined` fields mean "use built-in behavior". The resolved object is
 * frozen at definition time and consumed by all backend adapters.
 */
export interface ResolvedEntityStorageConventions {
  /** Resolved Redis key format function, or `undefined` for default format. */
  readonly redisKey?: (args: {
    appName: string;
    storageName: string;
    pk: string | number;
  }) => string;
  /** Resolved custom auto-default resolver, or `undefined` for built-in only. */
  readonly autoDefault?: CustomAutoDefaultResolver;
  /** Resolved custom on-update resolver, or `undefined` for built-in only. */
  readonly onUpdate?: CustomOnUpdateResolver;
}

// ============================================================================
// Resolved entity definition (output of defineEntity)
// ============================================================================

/**
 * The validated, frozen output of `defineEntity()`.
 *
 * Extends `EntityConfig` with derived fields computed at definition time:
 * - `_pkField` — the primary key field name
 * - `_storageName` — the table/collection name with namespace applied
 * - `_systemFields` — resolved audit, ownership, and tenant field names
 * - `_storageFields` — resolved Mongo PK and TTL column names
 * - `_conventions` — resolved storage convention overrides (Redis key, ID gen, etc.)
 *
 * The object is deeply frozen — all nested configs are immutable after `defineEntity()` returns.
 *
 * @template F - The fields record type from the entity definition.
 */
export interface ResolvedEntityConfig<
  F extends Record<string, FieldDef> = Record<string, FieldDef>,
> extends EntityConfig<F> {
  /** The primary key field name, extracted at definition time. */
  readonly _pkField: string;
  /** Table/collection name with namespace prefix applied. */
  readonly _storageName: string;
  /** Resolved system field names with defaults applied. @see {@link ResolvedEntitySystemFields} */
  readonly _systemFields: ResolvedEntitySystemFields;
  /** Resolved storage field mapping with defaults applied. @see {@link ResolvedEntityStorageFieldMap} */
  readonly _storageFields: ResolvedEntityStorageFieldMap;
  /** Resolved storage convention overrides. @see {@link ResolvedEntityStorageConventions} */
  readonly _conventions: ResolvedEntityStorageConventions;
}

// ============================================================================
// defineEntity()
// ============================================================================

/**
 * Define an entity — the entry point for the config-driven persistence system.
 *
 * Validates the config (primary key presence, soft-delete field existence, index field
 * references, pagination cursor fields, and search config) then returns a deep-frozen
 * `ResolvedEntityConfig` with `_pkField` and `_storageName` derived automatically.
 *
 * @param name - PascalCase entity name (e.g. `'Message'`, `'UserProfile'`).
 * @param config - The entity configuration object.
 * @returns A frozen `ResolvedEntityConfig` with derived metadata attached.
 * @throws If the entity has no primary key, multiple primary keys, invalid field references,
 *   or an invalid search configuration.
 *
 * @remarks
 * **Storage name derivation:** `_storageName` is derived from `name` by converting to
 * `snake_case`, applying English pluralisation rules, and prepending `namespace_` when
 * a namespace is provided. Examples:
 *
 * | Name          | Namespace  | `_storageName`         |
 * |---------------|------------|------------------------|
 * | `Message`     | `'chat'`   | `'chat_messages'`      |
 * | `MyEntity`    | `'chat'`   | `'chat_my_entities'`   |
 * | `Category`    | —          | `'categories'`         |
 * | `Activity`    | —          | `'activities'`         |
 * | `Box`         | —          | `'boxes'`              |
 * | `Status`      | —          | `'statuses'`           |
 *
 * Pluralisation rules applied in order:
 * 1. Ends in `y` **preceded by a consonant** → replace `y` with `ies`
 *    (`category` → `categories`, `activity` → `activities`).
 *    Vowel-preceded `y` (`day`, `key`) gets a plain `s` suffix.
 * 2. Ends in `s`, `x`, `z`, `sh`, or `ch` → append `es` (`box` → `boxes`).
 * 3. All other cases → append `s`.
 *
 * To override the derived name (e.g. for an irregular plural or a legacy table),
 * set `storage.sqlite.tableName` / `storage.postgres.tableName` /
 * `storage.mongo.collectionName` in `EntityStorageHints`. The `_storageName` value
 * itself cannot be overridden — it is used as the canonical key for event bus routing
 * and WebSocket room names regardless of backing-store table names.
 *
 * @example
 * ```ts
 * import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
 *
 * export const Message = defineEntity('Message', {
 *   namespace: 'chat',
 *   fields: {
 *     id:        field.string({ primary: true, default: 'uuid' }),
 *     roomId:    field.string(),
 *     content:   field.string(),
 *     createdAt: field.date({ default: 'now' }),
 *   },
 *   indexes: [index(['roomId', 'createdAt'], { direction: 'desc' })],
 * });
 * ```
 */
export function defineEntity<F extends Record<string, FieldDef>>(
  name: string,
  config: Omit<EntityConfig<F>, 'name'>,
): ResolvedEntityConfig<F> {
  const fields = config.fields;

  // Find primary key
  let pkField: string | undefined;
  for (const [fieldName, def] of Object.entries(fields)) {
    if (def.primary) {
      if (pkField) {
        throw new Error(
          `[defineEntity:${name}] Multiple primary key fields: ${pkField}, ${fieldName}`,
        );
      }
      pkField = fieldName;
    }
  }
  if (!pkField) {
    throw new Error(`[defineEntity:${name}] No primary key field defined`);
  }

  // Validate PK type
  const pkDef = fields[pkField];
  if (pkDef.type !== 'string' && pkDef.type !== 'number' && pkDef.type !== 'integer') {
    throw new Error(
      `[defineEntity:${name}] Primary key must be string, number, or integer — got '${pkDef.type}'`,
    );
  }

  // Use a helper to safely check field existence at runtime.
  // `fields` is typed as F (Record<string, FieldDef>), so indexed access is always FieldDef
  // at the type level — but user input may reference non-existent field names at runtime.
  const fieldExists = (key: string): boolean =>
    (fields as Record<string, FieldDef | undefined>)[key] !== undefined;

  // Validate softDelete field exists
  if (config.softDelete) {
    const sdField = config.softDelete.field;
    if (!fieldExists(sdField)) {
      throw new Error(`[defineEntity:${name}] softDelete.field '${sdField}' not found in fields`);
    }
  }

  // Validate tenant field exists
  if (config.tenant) {
    const tf = config.tenant.field;
    if (!fieldExists(tf)) {
      throw new Error(`[defineEntity:${name}] tenant.field '${tf}' not found in fields`);
    }
  }

  // Validate index fields exist
  if (config.indexes) {
    for (const idx of config.indexes) {
      for (const f of idx.fields) {
        if (!fieldExists(f)) {
          throw new Error(`[defineEntity:${name}] Index references unknown field '${f}'`);
        }
      }
    }
  }

  // Validate pagination cursor fields exist
  if (config.pagination?.cursor) {
    for (const f of config.pagination.cursor.fields) {
      if (!fieldExists(f)) {
        throw new Error(`[defineEntity:${name}] pagination.cursor references unknown field '${f}'`);
      }
    }
  }

  // Validate search configuration
  if (config.search) {
    const search = config.search;

    // Every key in search.fields must exist in entity fields
    for (const fieldName of Object.keys(search.fields)) {
      if (!fieldExists(fieldName)) {
        throw new Error(
          `[defineEntity:${name}] search.fields references unknown field '${fieldName}'`,
        );
      }
    }

    // At least one field must be searchable (searchable defaults to true when unset)
    const hasSearchable = Object.values(search.fields).some(fc => fc.searchable !== false);
    if (!hasSearchable) {
      throw new Error(
        `[defineEntity:${name}] search.fields must contain at least one searchable field (searchable defaults to true)`,
      );
    }

    // Validate weight is positive when specified
    for (const [fieldName, fc] of Object.entries(search.fields)) {
      if (fc.weight !== undefined && fc.weight <= 0) {
        throw new Error(
          `[defineEntity:${name}] search.fields.${fieldName}.weight must be positive, got ${fc.weight}`,
        );
      }
    }

    // Validate geo fields exist and are number type
    if (search.geo) {
      const { latField, lngField } = search.geo;
      if (!fieldExists(latField)) {
        throw new Error(
          `[defineEntity:${name}] search.geo.latField '${latField}' not found in fields`,
        );
      }
      if (fields[latField].type !== 'number') {
        throw new Error(
          `[defineEntity:${name}] search.geo.latField '${latField}' must be type 'number', got '${fields[latField].type}'`,
        );
      }
      if (!fieldExists(lngField)) {
        throw new Error(
          `[defineEntity:${name}] search.geo.lngField '${lngField}' not found in fields`,
        );
      }
      if (fields[lngField].type !== 'number') {
        throw new Error(
          `[defineEntity:${name}] search.geo.lngField '${lngField}' must be type 'number', got '${fields[lngField].type}'`,
        );
      }
    }

    // Validate distinctField exists in entity fields
    if (search.distinctField) {
      if (!fieldExists(search.distinctField)) {
        throw new Error(
          `[defineEntity:${name}] search.distinctField '${search.distinctField}' not found in fields`,
        );
      }
    }
  }

  // Derive storage name
  const namespace = config.namespace;
  const snake = name
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
  const pluralName =
    snake.endsWith('y') && !/[aeiou]y$/.test(snake)
      ? snake.slice(0, -1) + 'ies'
      : snake.endsWith('s') ||
          snake.endsWith('x') ||
          snake.endsWith('z') ||
          snake.endsWith('sh') ||
          snake.endsWith('ch')
        ? snake + 'es'
        : snake + 's';
  const storageName = namespace ? `${namespace}_${pluralName}` : pluralName;

  const resolvedSystemFields: ResolvedEntitySystemFields = {
    createdBy: config.systemFields?.createdBy ?? 'createdBy',
    updatedBy: config.systemFields?.updatedBy ?? 'updatedBy',
    ownerField: config.systemFields?.ownerField ?? 'ownerId',
    tenantField: config.systemFields?.tenantField ?? config.tenant?.field ?? 'tenantId',
    version: config.systemFields?.version ?? 'version',
  };

  const resolvedStorageFields: ResolvedEntityStorageFieldMap = {
    mongoPkField: config.storageFields?.mongoPkField ?? '_id',
    ttlField: config.storageFields?.ttlField ?? '_expires_at',
    mongoTtlField: config.storageFields?.mongoTtlField ?? '_expiresAt',
  };

  const resolvedConventions: ResolvedEntityStorageConventions = {
    redisKey: config.conventions?.redisKey,
    autoDefault: config.conventions?.autoDefault,
    onUpdate: config.conventions?.onUpdate,
  };

  const resolved: ResolvedEntityConfig<F> = {
    name,
    ...config,
    _pkField: pkField,
    _storageName: storageName,
    _systemFields: resolvedSystemFields,
    _storageFields: resolvedStorageFields,
    _conventions: resolvedConventions,
  };
  deepFreezeEntity(resolved);
  return resolved;
}

/**
 * Deep-freeze an entity config and all nested objects.
 * Matches the pattern used by definePlatform, defineInfra, and auth config.
 */
function deepFreezeEntity(obj: object): void {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreezeEntity(value as object);
    }
  }
}
