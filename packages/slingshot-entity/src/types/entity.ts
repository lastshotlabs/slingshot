/**
 * Entity configuration types.
 */
import type {
  EntityRouteConfig,
  EntityStorageConventions,
  EntityStorageFieldMap,
  EntitySystemFields,
  ResolvedEntityStorageConventions,
  ResolvedEntityStorageFieldMap,
  ResolvedEntitySystemFields,
  SoftDeleteConfig,
} from '@lastshotlabs/slingshot-core';
import type { FieldDef } from './fields';

/**
 * Describes a single database index on one or more entity fields.
 *
 * Passed to `EntityConfig.indexes`. The code generator and migration scripts
 * use this to emit `CREATE INDEX` statements for each backend.
 *
 * @example
 * ```ts
 * import { index } from '@lastshotlabs/slingshot-entity';
 *
 * const statusIndex = index(['status'], { direction: 'asc' });
 * const emailIndex  = index(['email'], { unique: true });
 * ```
 */
export interface IndexDef {
  /** Field names to include in the index, in order. */
  readonly fields: readonly string[];
  /** Sort direction for the index. Defaults to `'asc'` when omitted. */
  readonly direction?: 'asc' | 'desc';
  /** When true a unique constraint is created instead of a plain index. */
  readonly unique?: boolean;
}

/**
 * Describes a foreign-key relationship from this entity to another.
 *
 * Used by the code generator to emit typed relation accessors. Relations are
 * informational at the database level — no FK constraints are created unless
 * the consumer's migration scripts add them manually.
 *
 * @example
 * ```ts
 * import { relation } from '@lastshotlabs/slingshot-entity';
 *
 * const authorRel = relation.belongsTo('User', 'authorId');
 * const tagsRel   = relation.hasMany('Tag', 'postId');
 * ```
 */
export interface RelationDef {
  readonly kind: 'belongsTo' | 'hasMany' | 'hasOne';
  /** The name of the related entity (must match its `defineEntity()` name). */
  readonly target: string;
  /** The field on this entity (or the related entity for `hasMany`/`hasOne`) that stores the FK. */
  readonly foreignKey: string;
  /** When true the foreign key may be null (only meaningful for `belongsTo`). */
  readonly optional?: boolean;
}

export type { SoftDeleteConfig };

/**
 * Cursor-based pagination configuration for list operations.
 *
 * When set, the generated `list()` method accepts a `cursor` parameter and
 * returns `nextCursor` alongside the result items.
 *
 * @example
 * ```ts
 * const pagination: PaginationConfig = {
 *   cursor: { fields: ['createdAt', 'id'] },
 *   defaultLimit: 20,
 *   maxLimit: 100,
 * };
 * ```
 */
export interface PaginationConfig {
  /** Fields whose values form the opaque cursor token. */
  readonly cursor: { readonly fields: readonly string[] };
  /** Number of items returned when the caller does not specify a limit. */
  readonly defaultLimit?: number;
  /** Hard cap on items per page regardless of what the caller requests. */
  readonly maxLimit?: number;
}

/**
 * Multi-tenant isolation configuration.
 *
 * When set, every database query automatically filters by the value stored in
 * `field` — preventing cross-tenant data access. The field must exist in
 * `EntityConfig.fields`.
 *
 * @example
 * ```ts
 * import { defineEntity, field } from '@lastshotlabs/slingshot-entity';
 * import type { TenantConfig } from '@lastshotlabs/slingshot-entity';
 *
 * const tenantConfig: TenantConfig = { field: 'tenantId' };
 *
 * const Post = defineEntity('Post', {
 *   fields: {
 *     id:       field.string({ primary: true, default: 'uuid' }),
 *     tenantId: field.string(),
 *     title:    field.string(),
 *   },
 *   tenant: tenantConfig,
 * });
 * ```
 */
export interface TenantConfig {
  /** The entity field that holds the tenant identifier. */
  readonly field: string;
  /**
   * When true the tenant field may be absent on some records.
   * Typically false — only set for entities shared across tenant boundaries.
   */
  readonly optional?: boolean;
}

/**
 * Per-backend storage customisation hints.
 *
 * All properties are optional. When omitted, each backend derives its table /
 * collection name from the entity's `_storageName`.
 *
 * @remarks
 * These are hints, not guarantees — backends that don't support a given hint
 * silently ignore it.
 *
 * @example
 * ```ts
 * import { defineEntity, field } from '@lastshotlabs/slingshot-entity';
 * import type { EntityStorageHints } from '@lastshotlabs/slingshot-entity';
 *
 * const storage: EntityStorageHints = {
 *   sqlite:   { tableName: 'msg' },
 *   postgres: { tableName: 'messages' },
 *   mongo:    { collectionName: 'messages' },
 *   redis:    { keyPrefix: 'msg:' },
 * };
 *
 * const Message = defineEntity('Message', {
 *   fields: { id: field.string({ primary: true, default: 'uuid' }) },
 *   storage,
 * });
 * ```
 */
export interface EntityStorageHints {
  /** Memory adapter: cap the number of records kept in memory. */
  readonly memory?: { readonly maxEntries?: number };
  /** Redis adapter: prefix applied to all keys for this entity. */
  readonly redis?: { readonly keyPrefix?: string };
  /** SQLite adapter: override the table name. */
  readonly sqlite?: { readonly tableName?: string };
  /** MongoDB adapter: override the collection name. */
  readonly mongo?: { readonly collectionName?: string };
  /** PostgreSQL adapter: override the table name. */
  readonly postgres?: { readonly tableName?: string };
}

/**
 * Time-to-live configuration for entities stored in TTL-capable backends
 * (e.g. Redis).
 *
 * Records are automatically expired after `defaultSeconds` unless the adapter
 * or caller overrides the TTL at write time.
 *
 * @example
 * ```ts
 * import { defineEntity, field } from '@lastshotlabs/slingshot-entity';
 * import type { EntityTtlConfig } from '@lastshotlabs/slingshot-entity';
 *
 * const ttl: EntityTtlConfig = { defaultSeconds: 3600 }; // 1 hour
 *
 * const Session = defineEntity('Session', {
 *   fields: { id: field.string({ primary: true, default: 'uuid' }) },
 *   ttl,
 * });
 * ```
 */
export interface EntityTtlConfig {
  /** Default record lifetime in seconds. */
  readonly defaultSeconds: number;
}

/**
 * The complete, unresolved entity configuration object passed to `defineEntity()`.
 *
 * `defineEntity()` validates this config, resolves `_pkField` and
 * `_storageName`, and returns a frozen `ResolvedEntityConfig`.
 *
 * @typeParam F - The fields record type. Inferred when using `field.*()` builders.
 *
 * @example
 * ```ts
 * import { defineEntity, field } from '@lastshotlabs/slingshot-entity';
 *
 * const Post = defineEntity('Post', {
 *   fields: {
 *     id:        field.string({ primary: true, default: 'uuid' }),
 *     title:     field.string(),
 *     status:    field.enum(['draft', 'published', 'archived']),
 *     createdAt: field.date({ default: 'now' }),
 *   },
 *   indexes: [{ fields: ['status'] }],
 *   softDelete: { field: 'status', value: 'archived' },
 * });
 * ```
 */
export interface EntityConfig<F extends Record<string, FieldDef> = Record<string, FieldDef>> {
  readonly name: string;
  /** Optional namespace prefix applied to the derived storage name. */
  readonly namespace?: string;
  readonly fields: F;
  /** Soft-delete configuration. When set, "deleted" records are filtered rather than removed. */
  readonly softDelete?: SoftDeleteConfig;
  /** Default field and direction for list queries that omit an explicit sort. */
  readonly defaultSort?: { readonly field: string; readonly direction: 'asc' | 'desc' };
  readonly pagination?: PaginationConfig;
  readonly indexes?: readonly IndexDef[];
  /**
   * Unique constraints. Each entry generates a `UNIQUE` index (SQL) or a
   * unique compound index (Mongo). The `upsert` flag is informational.
   */
  readonly uniques?: readonly { readonly fields: readonly string[]; readonly upsert?: boolean }[];
  readonly relations?: Record<string, RelationDef>;
  readonly tenant?: TenantConfig;
  readonly ttl?: EntityTtlConfig;
  readonly storage?: EntityStorageHints;
  /** Declarative route configuration. When set, route generation includes auth,
   *  permissions, rate limits, events, and middleware. */
  readonly routes?: EntityRouteConfig;
  /**
   * Consumer-configurable system field name overrides.
   *
   * Allows renaming audit (`createdBy`, `updatedBy`), ownership (`ownerId`),
   * tenant (`tenantId`), and version (`version`) field names to match the
   * consumer's domain model. Defaults are applied at `defineEntity()` time.
   *
   * @see {@link EntitySystemFields} for available fields and defaults.
   */
  readonly systemFields?: EntitySystemFields;
  /**
   * Storage-level field name overrides for backend adapters.
   *
   * Controls Mongo primary key field (`_id`) and SQL TTL column (`_expires_at`)
   * names. Adapters read the resolved mapping instead of hardcoding conventions.
   *
   * @see {@link EntityStorageFieldMap} for available fields and defaults.
   */
  readonly storageFields?: EntityStorageFieldMap;
  /**
   * Storage convention overrides for Redis key format, custom ID generation
   * strategies (beyond `'uuid' | 'cuid' | 'now'`), and custom on-update
   * strategies (beyond `'now'`).
   *
   * @see {@link EntityStorageConventions} for available convention hooks.
   */
  readonly conventions?: EntityStorageConventions;
}

/**
 * A fully resolved, immutable entity configuration.
 *
 * Produced by `defineEntity()` and used by all downstream APIs — code
 * generation, the audit runner, the migration differ, and the plugin factory.
 * The config is deep-frozen at creation time (CLAUDE.md rule 12) and must not
 * be mutated.
 *
 * @typeParam F - The fields record type, carried through from `EntityConfig`.
 *
 * @example
 * ```ts
 * import { defineEntity, field } from '@lastshotlabs/slingshot-entity';
 * import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-entity';
 *
 * const Message = defineEntity('Message', {
 *   fields: { id: field.string({ primary: true, default: 'uuid' }) },
 * });
 *
 * // Type-narrowed access:
 * const config: ResolvedEntityConfig = Message;
 * console.log(config._pkField);     // 'id'
 * console.log(config._storageName); // 'messages'
 * ```
 */
export interface ResolvedEntityConfig<
  F extends Record<string, FieldDef> = Record<string, FieldDef>,
> extends EntityConfig<F> {
  /** The name of the primary key field, resolved from the field with `primary: true`. */
  readonly _pkField: string;
  /**
   * The derived storage identifier used as the table name / collection name /
   * Redis key prefix. Computed from the entity name and optional namespace.
   */
  readonly _storageName: string;
  /** Resolved system field names with defaults applied. @see {@link ResolvedEntitySystemFields} */
  readonly _systemFields: ResolvedEntitySystemFields;
  /** Resolved storage field mapping with defaults applied. @see {@link ResolvedEntityStorageFieldMap} */
  readonly _storageFields: ResolvedEntityStorageFieldMap;
  /** Resolved storage convention overrides. @see {@link ResolvedEntityStorageConventions} */
  readonly _conventions: ResolvedEntityStorageConventions;
}
