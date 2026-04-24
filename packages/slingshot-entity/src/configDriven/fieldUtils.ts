/**
 * Shared field-mapping utilities for config-driven adapters.
 *
 * - camelCase ↔ snake_case conversion
 * - SQL / Mongo type mapping
 * - Record transformation (domain ↔ storage)
 * - Auto-default resolution
 * - Naming conventions per backend
 */
import type {
  AutoDefault,
  CustomAutoDefaultResolver,
  CustomOnUpdateResolver,
  FieldDef,
  FieldType,
  ResolvedEntityConfig,
} from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Case conversion
// ---------------------------------------------------------------------------

/**
 * Convert a `camelCase` string to `snake_case`.
 *
 * Used by SQL adapters to map domain field names to database column names.
 *
 * @param str - The camelCase string to convert.
 * @returns The snake_case equivalent.
 *
 * @example
 * ```ts
 * toSnakeCase('createdAt'); // 'created_at'
 * toSnakeCase('userId');    // 'user_id'
 * ```
 */
export function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

/**
 * Convert a `snake_case` string to `camelCase`.
 *
 * Used by SQL adapters to map database column names back to domain field names.
 *
 * @param str - The snake_case string to convert.
 * @returns The camelCase equivalent.
 *
 * @example
 * ```ts
 * toCamelCase('created_at'); // 'createdAt'
 * toCamelCase('user_id');    // 'userId'
 * ```
 */
export function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Config introspection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Auto-default resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an auto-default sentinel to its runtime value.
 *
 * Built-in sentinels are handled first:
 *
 * - `'uuid'` → a new `crypto.randomUUID()` string.
 * - `'cuid'` → a lightweight cuid-like string (`c<timestamp36><random6>`).
 *   Not cryptographically unique but collision-resistant for typical entity
 *   volumes.
 * - `'now'` → a `new Date()` representing the current wall-clock time.
 *
 * When the sentinel is not one of the built-in values, the optional
 * `customResolver` is invoked. If it returns a non-`undefined` value, that
 * value is used. If no custom resolver is provided or it returns `undefined`,
 * an error is thrown.
 *
 * @param sentinel - A built-in auto-default sentinel (`'uuid'`, `'cuid'`,
 *   `'now'`) or a custom string sentinel handled by `customResolver`.
 * @param customResolver - Optional function that maps non-built-in sentinel
 *   strings to their runtime values. Return `undefined` to signal that the
 *   sentinel is unrecognised (which causes an error to be thrown).
 * @returns A `string` for `'uuid'` and `'cuid'`, a `Date` for `'now'`, or
 *   whatever value the `customResolver` produces for custom sentinels.
 * @throws {Error} If the sentinel is not built-in and no `customResolver` is
 *   provided, or if the `customResolver` returns `undefined`.
 *
 * @example
 * ```ts
 * import { ulid } from 'ulid';
 *
 * const customResolver: CustomAutoDefaultResolver = (kind) => {
 *   if (kind === 'ulid') return ulid();
 *   return undefined; // unknown — let the framework throw
 * };
 *
 * resolveAutoDefault('uuid');                    // '550e8400-e29b-...'
 * resolveAutoDefault('ulid', customResolver);    // '01ARZ3NDEKTSV...'
 * resolveAutoDefault('unknown');                 // throws Error
 * ```
 *
 * @see {@link CustomAutoDefaultResolver} from `@lastshotlabs/slingshot-core`
 */
export function resolveAutoDefault(
  sentinel: AutoDefault | string,
  customResolver?: CustomAutoDefaultResolver,
): unknown {
  switch (sentinel) {
    case 'uuid':
      return crypto.randomUUID();
    case 'cuid':
      // Lightweight cuid-like: timestamp + random suffix
      return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    case 'now':
      return new Date();
    default: {
      if (customResolver) {
        const result = customResolver(sentinel);
        if (result !== undefined) return result;
      }
      throw new Error(`Unknown auto-default sentinel: '${sentinel}'`);
    }
  }
}

/**
 * Check if a default value is an auto-default sentinel.
 *
 * Used to distinguish between literal defaults (e.g. `0`, `'active'`) and
 * runtime-computed sentinels (`'uuid'`, `'cuid'`, `'now'`) so that
 * `applyDefaults` can dispatch to `resolveAutoDefault` only when needed.
 *
 * @param value - The field default value from a `FieldDef`.
 * @returns `true` if `value` is one of `'uuid'`, `'cuid'`, or `'now'`.
 */
export function isAutoDefault(value: string | number | boolean | undefined): value is AutoDefault {
  return value === 'uuid' || value === 'now' || value === 'cuid';
}

/**
 * Apply auto-defaults and literal defaults to a create input, producing a
 * full entity record ready for persistence.
 *
 * For each field that is absent from `input` but has a `default` defined in
 * its `FieldDef`, the default is resolved as follows:
 *
 * 1. **Built-in auto-default** (`'uuid'`, `'cuid'`, `'now'`): delegated to
 *    {@link resolveAutoDefault} (with `customAutoDefault` forwarded).
 * 2. **Custom string default**: if `customAutoDefault` is provided and the
 *    default value is a string that is not a built-in sentinel, the resolver
 *    is called. If it returns a non-`undefined` value, that value is used;
 *    otherwise the literal string is used as-is.
 * 3. **Literal default** (number, boolean, or unresolved string): applied
 *    directly as the field value.
 *
 * Fields already present in `input` are never overwritten.
 *
 * @param input - The caller-supplied create payload. Keys are camelCase field
 *   names; values are domain-layer types. This object is not mutated.
 * @param fields - The entity's field definitions keyed by camelCase name.
 *   Each `FieldDef.default` is inspected to determine whether a default
 *   should be applied.
 * @param customAutoDefault - Optional resolver for non-built-in auto-default
 *   sentinels. When a field's default is a string that is not `'uuid'`,
 *   `'cuid'`, or `'now'`, this function is called with that string. Return a
 *   value to use it as the default, or `undefined` to fall back to the
 *   literal string.
 * @returns A new record containing all properties from `input` plus any
 *   resolved defaults for missing fields.
 *
 * @see {@link CustomAutoDefaultResolver} from `@lastshotlabs/slingshot-core`
 */
export function applyDefaults(
  input: Record<string, unknown>,
  fields: Record<string, FieldDef>,
  customAutoDefault?: CustomAutoDefaultResolver,
): Record<string, unknown> {
  const record: Record<string, unknown> = { ...input };

  for (const [name, def] of Object.entries(fields)) {
    if (record[name] !== undefined) continue;

    if (def.default !== undefined) {
      if (isAutoDefault(def.default)) {
        record[name] = resolveAutoDefault(def.default, customAutoDefault);
      } else if (typeof def.default === 'string' && customAutoDefault) {
        const custom = customAutoDefault(def.default);
        if (custom !== undefined) {
          record[name] = custom;
        } else {
          record[name] = def.default;
        }
      } else {
        record[name] = def.default;
      }
    }
  }

  return record;
}

/**
 * Apply `onUpdate` fields to an update payload, injecting computed values
 * for fields that declare an `onUpdate` sentinel.
 *
 * Resolution order for each field with a non-`undefined` `onUpdate`:
 *
 * 1. **Built-in sentinel** (`'now'`): sets the field to `new Date()`.
 * 2. **Custom sentinel** (any other string): if `customOnUpdate` is provided,
 *    it is invoked with the sentinel string. When the resolver returns a
 *    non-`undefined` value, that value is written to the field. If the
 *    resolver returns `undefined`, the field is left unchanged (the sentinel
 *    is silently ignored).
 *
 * Values already present in `input` for non-`onUpdate` fields are preserved.
 * `onUpdate` fields are always overwritten regardless of whether the caller
 * included them in `input`.
 *
 * @param input - The caller-supplied update payload. Keys are camelCase field
 *   names; values are domain-layer types. This object is not mutated.
 * @param fields - The entity's field definitions keyed by camelCase name.
 *   Each `FieldDef.onUpdate` is inspected to determine whether a computed
 *   value should be injected.
 * @param customOnUpdate - Optional resolver invoked for non-built-in
 *   `onUpdate` sentinels (i.e. any string other than `'now'`). Return a
 *   value to inject it into the update payload, or `undefined` to skip the
 *   field.
 * @returns A new record containing all properties from `input` plus any
 *   computed `onUpdate` values.
 *
 * @see {@link CustomOnUpdateResolver} from `@lastshotlabs/slingshot-core`
 */
export function applyOnUpdate(
  input: Record<string, unknown>,
  fields: Record<string, FieldDef>,
  customOnUpdate?: CustomOnUpdateResolver,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...input };

  for (const [name, def] of Object.entries(fields)) {
    if (def.onUpdate === 'now') {
      result[name] = new Date();
    } else if (def.onUpdate && customOnUpdate) {
      const custom = customOnUpdate(def.onUpdate);
      if (custom !== undefined) {
        result[name] = custom;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// SQL type mapping
// ---------------------------------------------------------------------------

const SQLITE_TYPE_MAP: Record<FieldType, string> = {
  string: 'TEXT',
  number: 'REAL',
  integer: 'INTEGER',
  boolean: 'INTEGER', // SQLite: 0/1
  date: 'INTEGER', // Epoch ms
  enum: 'TEXT',
  json: 'TEXT', // JSON serialised
  'string[]': 'TEXT', // JSON serialised
};

const PG_TYPE_MAP: Record<FieldType, string> = {
  string: 'TEXT',
  number: 'NUMERIC',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  date: 'TIMESTAMPTZ',
  enum: 'TEXT',
  json: 'JSONB',
  'string[]': 'TEXT[]',
};

/**
 * Map a framework {@link FieldType} to the corresponding SQLite column type.
 *
 * @param fieldType - The framework field type from the entity definition.
 * @returns The SQLite column type string (e.g. `'TEXT'`, `'INTEGER'`, `'REAL'`).
 */
export function sqliteColumnType(fieldType: FieldType): string {
  return SQLITE_TYPE_MAP[fieldType];
}

/**
 * Map a framework {@link FieldType} to the corresponding PostgreSQL column type.
 *
 * @param fieldType - The framework field type from the entity definition.
 * @returns The Postgres column type string (e.g. `'TEXT'`, `'BOOLEAN'`, `'JSONB'`).
 */
export function pgColumnType(fieldType: FieldType): string {
  return PG_TYPE_MAP[fieldType];
}

// ---------------------------------------------------------------------------
// Domain ↔ SQLite row transformation
// ---------------------------------------------------------------------------

/**
 * Convert a domain record (camelCase keys, native types) to a SQLite row
 * (snake_case keys, serialised types).
 *
 * @param record - The domain record with camelCase field names and native JS types.
 * @param fields - The entity field definitions used for type-aware conversion.
 * @returns A new object with snake_case keys and SQLite-compatible values.
 */
export function toSqliteRow(
  record: Record<string, unknown>,
  fields: Record<string, FieldDef>,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};

  for (const [camel, def] of Object.entries(fields)) {
    const val = record[camel];
    if (val === undefined) continue;

    const snake = toSnakeCase(camel);
    row[snake] = domainToSqlite(val, def);
  }

  return row;
}

/**
 * Convert a single domain value to its SQLite storage representation.
 *
 * Type-specific conversions:
 * - `date`: stored as epoch milliseconds (`INTEGER`). A `Date` instance is
 *   converted via `.getTime()`; non-Date values are passed through unchanged
 *   (the caller is responsible for providing a valid epoch number).
 * - `boolean`: stored as `1` (truthy) or `0` (falsy) — SQLite has no native
 *   boolean type.
 * - `json` / `string[]`: serialised to a JSON string via `JSON.stringify`.
 * - All other types: returned as-is.
 *
 * @param val - The domain-layer value to convert.
 * @param def - The field definition describing the target type.
 * @returns The SQLite-compatible storage value.
 */
function domainToSqlite(val: unknown, def: FieldDef): unknown {
  switch (def.type) {
    case 'date':
      // Store as epoch ms
      return val instanceof Date ? val.getTime() : val;
    case 'boolean':
      return val ? 1 : 0;
    case 'json':
    case 'string[]':
      return JSON.stringify(val);
    default:
      return val;
  }
}

/**
 * Convert a SQLite row (snake_case keys) back to a domain record (camelCase keys,
 * native JS types).
 *
 * @param row - The raw SQLite row with snake_case column names.
 * @param fields - The entity field definitions used for type-aware conversion.
 * @returns A new object with camelCase keys and domain-layer types.
 */
export function fromSqliteRow(
  row: Record<string, unknown>,
  fields: Record<string, FieldDef>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};

  for (const [camel, def] of Object.entries(fields)) {
    const snake = toSnakeCase(camel);
    const val = row[snake];
    if (val === undefined || val === null) continue;

    record[camel] = sqliteToDomain(val, def);
  }

  return record;
}

/**
 * Safely coerce an unknown storage value to a `Date`.
 *
 * Handles the three representations produced by the persistence layer:
 * - `Date` instance: returned as-is.
 * - `number`: treated as epoch milliseconds and passed to `new Date(n)`.
 * - `string`: treated as an ISO 8601 date string and passed to `new Date(s)`.
 * - Any other type: returns `new Date(0)` (Unix epoch) as a sentinel fallback.
 *   This should not occur with valid data; the caller is expected to have
 *   stored a convertible value originally.
 *
 * @param val - The raw storage value to coerce.
 * @returns A `Date` object representing the value, or `new Date(0)` for
 *   unrecognised input types.
 */
export function coerceToDate(val: unknown): Date {
  if (val instanceof Date) return val;
  if (typeof val === 'number') return new Date(val);
  if (typeof val === 'string') return new Date(val);
  return new Date(0); // fallback — should not happen with valid data
}

/**
 * Convert a single SQLite storage value back to its domain representation.
 *
 * Type-specific conversions:
 * - `date`: converted from epoch ms integer (or ISO string) to a `Date` via
 *   `coerceToDate`.
 * - `boolean`: `1` or `true` → `true`; any other value → `false`.
 * - `json` / `string[]`: `JSON.parse` when the stored value is a string;
 *   returned as-is otherwise (defensive, should not occur with valid data).
 * - All other types: returned as-is.
 *
 * @param val - The SQLite row value to convert.
 * @param def - The field definition describing the source type.
 * @returns The domain-layer value.
 */
function sqliteToDomain(val: unknown, def: FieldDef): unknown {
  switch (def.type) {
    case 'date':
      return coerceToDate(val);
    case 'boolean':
      return val === 1 || val === true;
    case 'json':
    case 'string[]':
      return typeof val === 'string' ? JSON.parse(val) : val;
    default:
      return val;
  }
}

// ---------------------------------------------------------------------------
// Domain ↔ Postgres row transformation
// ---------------------------------------------------------------------------

/**
 * Convert a domain record to a Postgres row (snake_case keys, native PG types).
 *
 * @param record - The domain record with camelCase field names and native JS types.
 * @param fields - The entity field definitions used for type-aware conversion.
 * @returns A new object with snake_case keys and Postgres-compatible values.
 */
export function toPgRow(
  record: Record<string, unknown>,
  fields: Record<string, FieldDef>,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};

  for (const [camel, def] of Object.entries(fields)) {
    const val = record[camel];
    if (val === undefined) continue;

    const snake = toSnakeCase(camel);
    row[snake] = domainToPg(val, def);
  }

  return row;
}

/**
 * Convert a single domain value to its Postgres storage representation.
 *
 * Type-specific conversions:
 * - `date`: passed as a native `Date` object (the `pg` driver serialises it
 *   to `TIMESTAMPTZ`). Non-Date values are coerced via `coerceToDate`.
 * - `json`: serialised to a JSON string; the `pg` driver stores it in a
 *   `JSONB` column.
 * - `string[]` and all other types: passed through unchanged — Postgres and
 *   the `pg` driver handle them natively.
 *
 * @param val - The domain-layer value to convert.
 * @param def - The field definition describing the target type.
 * @returns The Postgres-compatible storage value.
 */
function domainToPg(val: unknown, def: FieldDef): unknown {
  switch (def.type) {
    case 'date':
      return val instanceof Date ? val : coerceToDate(val);
    case 'json':
      return JSON.stringify(val);
    // string[] and others are native in Postgres
    default:
      return val;
  }
}

/**
 * Convert a Postgres row (snake_case keys) back to a domain record (camelCase keys,
 * native JS types).
 *
 * @param row - The raw Postgres row with snake_case column names.
 * @param fields - The entity field definitions used for type-aware conversion.
 * @returns A new object with camelCase keys and domain-layer types.
 */
export function fromPgRow(
  row: Record<string, unknown>,
  fields: Record<string, FieldDef>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};

  for (const [camel, def] of Object.entries(fields)) {
    const snake = toSnakeCase(camel);
    const val = row[snake];
    if (val === undefined || val === null) continue;

    record[camel] = pgToDomain(val, def);
  }

  return record;
}

/**
 * Convert a single Postgres row value back to its domain representation.
 *
 * Type-specific conversions:
 * - `date`: the `pg` driver typically returns `Date` objects for
 *   `TIMESTAMPTZ` columns; non-Date values are coerced via `coerceToDate` as
 *   a defensive fallback.
 * - `json`: `JSONB` columns may arrive as already-parsed objects from the `pg`
 *   driver, or as JSON strings from some edge-case configurations. `JSON.parse`
 *   is called only when the value is a string.
 * - All other types: returned as-is.
 *
 * @param val - The Postgres row value to convert.
 * @param def - The field definition describing the source type.
 * @returns The domain-layer value.
 */
function pgToDomain(val: unknown, def: FieldDef): unknown {
  switch (def.type) {
    case 'date':
      return val instanceof Date ? val : coerceToDate(val);
    case 'json':
      return typeof val === 'string' ? JSON.parse(val) : val;
    default:
      return val;
  }
}

// ---------------------------------------------------------------------------
// Domain ↔ Redis (JSON serialised)
// ---------------------------------------------------------------------------

/**
 * Prepare a domain record for Redis JSON storage.
 *
 * Dates are stored as ISO strings for reversibility. All other types are
 * passed through unchanged — Redis stores the entire record as a single
 * JSON string.
 *
 * @param record - The domain record with native JS types.
 * @param fields - The entity field definitions used for type-aware conversion.
 * @returns A new object with Redis-compatible values (dates as ISO strings).
 */
export function toRedisRecord(
  record: Record<string, unknown>,
  fields: Record<string, FieldDef>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [name, def] of Object.entries(fields)) {
    const val = record[name];
    if (val === undefined) continue;
    out[name] = def.type === 'date' && val instanceof Date ? val.toISOString() : val;
  }

  return out;
}

/**
 * Restore a Redis JSON record back to domain types.
 *
 * Converts ISO date strings back to `Date` objects. All other types are
 * returned as-is.
 *
 * @param raw - The parsed JSON record from Redis.
 * @param fields - The entity field definitions used for type-aware conversion.
 * @returns A new object with domain-layer types (dates as `Date` objects).
 */
export function fromRedisRecord(
  raw: Record<string, unknown>,
  fields: Record<string, FieldDef>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};

  for (const [name, def] of Object.entries(fields)) {
    const val = raw[name];
    if (val === undefined || val === null) continue;
    record[name] = def.type === 'date' && typeof val === 'string' ? new Date(val) : val;
  }

  return record;
}

// ---------------------------------------------------------------------------
// Domain ↔ MongoDB
// ---------------------------------------------------------------------------

/**
 * Convert a domain record to a MongoDB document.
 *
 * The PK field is mapped to the configured Mongo PK storage field
 * (`config._storageFields.mongoPkField`, default `'_id'`).
 * Dates are native `Date` objects. JSON is native (Mongoose Mixed).
 *
 * @param record - The domain record with camelCase field names and native JS types.
 * @param config - The resolved entity config with PK field and storage field mapping.
 * @returns A new MongoDB document object with the PK remapped to the storage field.
 *
 * @see {@link EntityStorageFieldMap} for configuring the Mongo PK field name.
 */
export function toMongoDoc(
  record: Record<string, unknown>,
  config: ResolvedEntityConfig,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  const mongoPkField = config._storageFields.mongoPkField;

  for (const [name, def] of Object.entries(config.fields)) {
    const val = record[name];
    if (val === undefined) continue;

    if (def.primary) {
      doc[mongoPkField] = val;
    } else {
      doc[name] = def.type === 'date' && !(val instanceof Date) ? coerceToDate(val) : val;
    }
  }

  return doc;
}

/**
 * Convert a MongoDB document back to a domain record.
 *
 * Reads the PK from the configured Mongo PK storage field
 * (`config._storageFields.mongoPkField`, default `'_id'`).
 *
 * @param doc - The raw MongoDB document (from a `.lean()` query).
 * @param config - The resolved entity config with PK field and storage field mapping.
 * @returns A new object with domain field names and the PK mapped back.
 *
 * @see {@link EntityStorageFieldMap} for configuring the Mongo PK field name.
 */
export function fromMongoDoc(
  doc: Record<string, unknown>,
  config: ResolvedEntityConfig,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  const mongoPkField = config._storageFields.mongoPkField;

  for (const [name, def] of Object.entries(config.fields)) {
    if (def.primary) {
      record[name] = doc[mongoPkField];
    } else {
      const val = doc[name];
      if (val !== undefined && val !== null) {
        record[name] = val;
      }
    }
  }

  return record;
}

// ---------------------------------------------------------------------------
// Storage naming conventions
// ---------------------------------------------------------------------------

/**
 * Resolve the table, collection, or key prefix name for a given backend.
 *
 * Each backend has its own override in `config.storage`:
 * - **sqlite**: `config.storage.sqlite.tableName` → falls back to `_storageName`
 * - **postgres**: `config.storage.postgres.tableName` → falls back to `slingshot_<_storageName>`
 * - **mongo**: `config.storage.mongo.collectionName` → falls back to `_storageName`
 * - **redis**: `config.storage.redis.keyPrefix` → falls back to `_storageName`
 *
 * @param config - The resolved entity config containing storage hints and the derived `_storageName`.
 * @param backend - The storage backend to resolve the name for.
 * @returns The resolved storage identifier string.
 *
 * @see {@link EntityStorageHints} for per-backend override configuration.
 */
export function storageName(
  config: ResolvedEntityConfig,
  backend: 'sqlite' | 'postgres' | 'mongo' | 'redis',
): string {
  switch (backend) {
    case 'sqlite':
      return config.storage?.sqlite?.tableName ?? config._storageName;
    case 'postgres':
      return config.storage?.postgres?.tableName ?? `slingshot_${config._storageName}`;
    case 'mongo':
      return config.storage?.mongo?.collectionName ?? config._storageName;
    case 'redis':
      return config.storage?.redis?.keyPrefix ?? config._storageName;
  }
}

// ---------------------------------------------------------------------------
// Cursor encoding/decoding
// ---------------------------------------------------------------------------

/**
 * Encode cursor pagination state to an opaque base64url string.
 *
 * @param values - A record of field name → value pairs representing the cursor position.
 * @returns An opaque base64url-encoded JSON string.
 */
export function encodeCursor(values: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

/**
 * Decode an opaque cursor string back to pagination state.
 *
 * @param cursor - The base64url-encoded cursor string produced by {@link encodeCursor}.
 * @returns The decoded record of field name → value pairs.
 */
export function decodeCursor(cursor: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Soft-delete helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a record has been soft-deleted.
 *
 * Two soft-delete strategies are supported, both configured via
 * `config.softDelete`:
 * - **Value-based** (`'value' in config.softDelete`): the record is considered
 *   deleted when `record[field] === config.softDelete.value` (e.g. a status
 *   field equal to `'deleted'`).
 * - **Null-check** (no `value` property): the record is considered deleted when
 *   `record[field] != null` (i.e. a `deletedAt` timestamp has been set).
 *
 * @param record - The entity record to inspect.
 * @param config - The resolved entity configuration containing the optional
 *   `softDelete` strategy definition.
 * @returns `true` if the record is soft-deleted, `false` if it is alive or if
 *   the entity has no soft-delete configuration.
 */
export function isSoftDeleted(
  record: Record<string, unknown>,
  config: ResolvedEntityConfig,
): boolean {
  if (!config.softDelete) return false;
  if ('value' in config.softDelete) {
    return record[config.softDelete.field] === config.softDelete.value;
  }
  return record[config.softDelete.field] != null;
}

// ---------------------------------------------------------------------------
// Shared cursor/sort helpers (used by memory + redis in-process adapters)
// ---------------------------------------------------------------------------

/**
 * Build an opaque cursor string from a record's cursor field values.
 *
 * Extracts the values of each cursor field from the record, converts
 * `Date` values to ISO strings for serialisation, and encodes the result
 * via {@link encodeCursor}.
 *
 * @param record - The entity record to extract cursor field values from.
 * @param cursorFields - Ordered list of field names that form the cursor.
 * @returns An opaque base64url-encoded cursor string.
 */
export function buildCursorForRecord(
  record: Record<string, unknown>,
  cursorFields: readonly string[],
): string {
  const values: Record<string, unknown> = {};
  for (const f of cursorFields) {
    const val = record[f];
    values[f] = val instanceof Date ? val.toISOString() : val;
  }
  return encodeCursor(values);
}

/**
 * Compare two records by cursor fields for in-memory sorting.
 *
 * Iterates over `cursorFields` in order, returning as soon as a non-equal pair
 * is found (tie-breaking semantics). The comparison is type-aware:
 * - `Date` vs `Date`: compared by epoch ms.
 * - `number` vs `number`: compared numerically.
 * - Everything else: compared as strings via `String()` coercion.
 *
 * The sign of the result is flipped when `sortDir === 'desc'`.
 *
 * @param a - The first record to compare.
 * @param b - The second record to compare.
 * @param cursorFields - Ordered list of field names to compare on.
 * @param sortDir - Sort direction: `'asc'` or `'desc'`.
 * @returns A negative number if `a` should sort before `b`, a positive number
 *   if `a` should sort after `b`, or `0` if the records are equal across all
 *   cursor fields.
 */
export function compareForSort(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  cursorFields: readonly string[],
  sortDir: 'asc' | 'desc',
): number {
  for (const f of cursorFields) {
    const aVal = a[f];
    const bVal = b[f];
    if (aVal === bVal) continue;

    let cmp: number;
    if (aVal instanceof Date && bVal instanceof Date) {
      cmp = aVal.getTime() - bVal.getTime();
    } else if (typeof aVal === 'number' && typeof bVal === 'number') {
      cmp = aVal - bVal;
    } else {
      cmp = String(aVal) < String(bVal) ? -1 : 1;
    }

    return sortDir === 'desc' ? -cmp : cmp;
  }
  return 0;
}
