/**
 * Shared naming helpers used by all generators.
 *
 * Pure, stateless utility functions for converting entity field names and
 * configs into backend-specific representations. Used by every code generator
 * in this package — do not add generator-specific logic here.
 */
import type { FieldDef, FieldType, ResolvedEntityConfig } from '../types';

/**
 * Convert a camelCase or PascalCase identifier to snake_case.
 *
 * Inserts an underscore before each uppercase letter, lowercases the entire
 * string, then strips any leading underscore that would result from a leading
 * capital (e.g. a PascalCase class name).
 *
 * @param str - The camelCase or PascalCase string to convert.
 * @returns The snake_case equivalent.
 *
 * @example
 * ```ts
 * toSnakeCase('userId')      // 'user_id'
 * toSnakeCase('createdAt')   // 'created_at'
 * toSnakeCase('PostComment') // 'post_comment'
 * toSnakeCase('id')          // 'id'
 * ```
 */
export function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

/**
 * Quote a SQL identifier (table, column, index name) with double quotes.
 *
 * Escapes any embedded double quotes by doubling them, then wraps the result
 * in double quotes. Conforms to the SQL standard and works for both SQLite
 * and PostgreSQL. Use this any time a table, column, or index name is
 * interpolated into a generated SQL statement to prevent injection and handle
 * reserved-word collisions.
 *
 * @param ident - The raw identifier string (e.g. a table or column name).
 * @returns The double-quoted, escaped identifier ready for embedding in SQL.
 *
 * @example
 * ```ts
 * quoteSqlIdent('user_id')    // '"user_id"'
 * quoteSqlIdent('order')      // '"order"'   — reserved word safe
 * quoteSqlIdent('say "hi"')   // '"say ""hi"""'
 * ```
 */
export function quoteSqlIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

/**
 * Escape a SQL string literal by doubling embedded single quotes and wrapping
 * in single quotes.
 *
 * Produces a safe, quoted string literal suitable for embedding in generated
 * SQL. Works for both SQLite and PostgreSQL. Use when inlining a known-safe
 * default value (e.g. an enum default) into a generated DDL statement.
 *
 * @param value - The raw string value to escape.
 * @returns A single-quoted SQL string literal with internal quotes doubled.
 *
 * @example
 * ```ts
 * escapeSqlString('hello')       // "'hello'"
 * escapeSqlString("it's alive")  // "'it''s alive'"
 * escapeSqlString('')            // "''"
 * ```
 */
export function escapeSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Escape a string for safe embedding inside a double-quoted JavaScript string
 * literal.
 *
 * Escapes backslashes, double quotes, newlines, carriage returns, and tabs so
 * the result can be placed between `"..."` in generated JavaScript/TypeScript
 * source or in `mongosh`-runnable migration scripts without breaking string
 * boundaries or injecting control characters.
 *
 * @param value - The raw string to escape.
 * @returns The escaped string, ready to be wrapped in double quotes.
 *
 * @example
 * ```ts
 * escapeJsString('hello')          // 'hello'
 * escapeJsString('say "hi"')       // 'say \\"hi\\"'
 * escapeJsString('line1\nline2')   // 'line1\\nline2'
 * escapeJsString('C:\\Users\\foo') // 'C:\\\\Users\\\\foo'
 * ```
 *
 * @remarks
 * Used by the Mongo migration generator to safely inline collection and field
 * names into `mongosh`-runnable scripts. Not intended for sanitising runtime
 * user input — use parameterised queries for that.
 */
export function escapeJsString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Determine whether a field default value is an auto-generated sentinel.
 *
 * Auto defaults are the string tokens `'uuid'`, `'now'`, and `'cuid'`. When a
 * field uses one of these tokens as its default, generators emit a DB-level
 * `DEFAULT` expression rather than an application-supplied literal value.
 *
 * @param d - The raw default value from a `FieldDef` (may be any type).
 * @returns `true` when `d` is one of the recognised auto-default sentinels.
 *
 * @example
 * ```ts
 * isAutoDefault('uuid')  // true
 * isAutoDefault('now')   // true
 * isAutoDefault('cuid')  // true
 * isAutoDefault('hello') // false
 * isAutoDefault(0)       // false
 * isAutoDefault(null)    // false
 * ```
 */
export function isAutoDefault(d: unknown): boolean {
  return d === 'uuid' || d === 'now' || d === 'cuid';
}

/**
 * Derive the TypeScript type string for a given `FieldDef`.
 *
 * Maps each supported `FieldType` to its TypeScript equivalent for use in
 * generated type declarations. Enum fields with declared values are emitted as
 * a union of string literals; enums without values fall back to `string`. JSON
 * fields emit `unknown` so consumers must narrow the type themselves.
 *
 * @param def - The field definition from a `ResolvedEntityConfig`.
 * @returns A TypeScript type expression string (e.g. `'string'`, `'number'`,
 *   `'Date'`, `"'active' | 'inactive'"`, `'unknown'`).
 *
 * @example
 * ```ts
 * tsType({ type: 'string' })                          // 'string'
 * tsType({ type: 'integer' })                         // 'number'
 * tsType({ type: 'boolean' })                         // 'boolean'
 * tsType({ type: 'date' })                            // 'Date'
 * tsType({ type: 'enum', enumValues: ['a', 'b'] })   // "'a' | 'b'"
 * tsType({ type: 'enum', enumValues: [] })            // 'string'
 * tsType({ type: 'json' })                            // 'unknown'
 * tsType({ type: 'string[]' })                        // 'string[]'
 * ```
 */
export function tsType(def: FieldDef): string {
  switch (def.type) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'Date';
    case 'enum':
      if (def.enumValues && def.enumValues.length > 0) {
        return def.enumValues.map(v => `'${v}'`).join(' | ');
      }
      return 'string';
    case 'json':
      return 'unknown';
    case 'string[]':
      return 'string[]';
    default:
      return 'unknown';
  }
}

/**
 * Return the SQLite column type string for a given `FieldType`.
 *
 * Booleans and dates are stored as `INTEGER` in SQLite (SQLite has no native
 * boolean or timestamp type). JSON and `string[]` values are serialised to
 * `TEXT`. Use this when generating SQLite DDL (`CREATE TABLE` / `ALTER TABLE`)
 * statements.
 *
 * @param t - The field type from a `FieldDef`.
 * @returns The SQLite affinity keyword (`'TEXT'`, `'REAL'`, `'INTEGER'`).
 *
 * @example
 * ```ts
 * sqliteColType('string')   // 'TEXT'
 * sqliteColType('number')   // 'REAL'
 * sqliteColType('integer')  // 'INTEGER'
 * sqliteColType('boolean')  // 'INTEGER'
 * sqliteColType('date')     // 'INTEGER'
 * sqliteColType('enum')     // 'TEXT'
 * sqliteColType('json')     // 'TEXT'
 * sqliteColType('string[]') // 'TEXT'
 * ```
 */
export function sqliteColType(t: FieldType): string {
  const map: Record<FieldType, string> = {
    string: 'TEXT',
    number: 'REAL',
    integer: 'INTEGER',
    boolean: 'INTEGER',
    date: 'INTEGER',
    enum: 'TEXT',
    json: 'TEXT',
    'string[]': 'TEXT',
  };
  return map[t];
}

/**
 * Return the PostgreSQL column type string for a given `FieldType`.
 *
 * Uses native PostgreSQL types: `BOOLEAN` for booleans, `TIMESTAMPTZ` for
 * dates (timezone-aware), `JSONB` for JSON fields (binary, indexed), and
 * `TEXT[]` for string arrays. Use this when generating PostgreSQL DDL
 * (`CREATE TABLE` / `ALTER TABLE`) statements.
 *
 * @param t - The field type from a `FieldDef`.
 * @returns The PostgreSQL column type keyword (e.g. `'TEXT'`, `'INTEGER'`,
 *   `'BOOLEAN'`, `'TIMESTAMPTZ'`, `'JSONB'`, `'TEXT[]'`).
 *
 * @example
 * ```ts
 * pgColType('string')   // 'TEXT'
 * pgColType('number')   // 'NUMERIC'
 * pgColType('integer')  // 'INTEGER'
 * pgColType('boolean')  // 'BOOLEAN'
 * pgColType('date')     // 'TIMESTAMPTZ'
 * pgColType('enum')     // 'TEXT'
 * pgColType('json')     // 'JSONB'
 * pgColType('string[]') // 'TEXT[]'
 * ```
 */
export function pgColType(t: FieldType): string {
  const map: Record<FieldType, string> = {
    string: 'TEXT',
    number: 'NUMERIC',
    integer: 'INTEGER',
    boolean: 'BOOLEAN',
    date: 'TIMESTAMPTZ',
    enum: 'TEXT',
    json: 'JSONB',
    'string[]': 'TEXT[]',
  };
  return map[t];
}

/**
 * Derive the backend-specific storage name for an entity.
 *
 * Returns the name that should be used when addressing this entity's backing
 * store — the table name for relational backends, the collection name for
 * Mongo, or the key prefix for Redis. Falls back to the entity's canonical
 * `_storageName` when no backend-specific override is configured, except for
 * PostgreSQL which prefixes with `slingshot_` by default to avoid collisions with
 * system tables.
 *
 * @param config - The resolved entity config from `defineEntity()`.
 * @param backend - The target backend: `'sqlite'`, `'postgres'`, `'mongo'`, or
 *   `'redis'`.
 * @returns The storage name string for the given backend.
 *
 * @example
 * ```ts
 * // Entity with _storageName = 'message', no storage overrides:
 * storageName(config, 'sqlite')    // 'message'
 * storageName(config, 'postgres')  // 'slingshot_message'
 * storageName(config, 'mongo')     // 'message'
 * storageName(config, 'redis')     // 'message'
 *
 * // Entity with storage.postgres.tableName = 'chat_messages':
 * storageName(config, 'postgres')  // 'chat_messages'
 * ```
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

/**
 * Return the maximum number of entries for the in-memory store for an entity.
 *
 * Reads `config.storage.memory.maxEntries` and falls back to `10 000` when no
 * override is configured. The in-memory adapter evicts the oldest entries when
 * this limit is reached, so set it appropriately for production-like test
 * environments.
 *
 * @param config - The resolved entity config from `defineEntity()`.
 * @returns The maximum entry count for the memory adapter (default: `10_000`).
 *
 * @example
 * ```ts
 * // Entity with no memory config:
 * memoryMaxEntries(config)  // 10_000
 *
 * // Entity with storage.memory.maxEntries = 500:
 * memoryMaxEntries(config)  // 500
 * ```
 */
export function memoryMaxEntries(config: ResolvedEntityConfig): number {
  return config.storage?.memory?.maxEntries ?? 10_000;
}

/**
 * Return the fields of an entity config as `[name, def]` pairs.
 *
 * A convenience wrapper over `Object.entries(config.fields)` that preserves
 * the correct `FieldDef` type on each entry. Use this in generators to iterate
 * over all fields without manually casting the entries tuple.
 *
 * @param config - The resolved entity config from `defineEntity()`.
 * @returns An array of `[fieldName, FieldDef]` tuples in definition order.
 *
 * @example
 * ```ts
 * for (const [name, def] of fieldEntries(config)) {
 *   console.log(name, tsType(def));  // e.g. 'userId' 'string'
 * }
 * ```
 */
export function fieldEntries(config: ResolvedEntityConfig): Array<[string, FieldDef]> {
  return Object.entries(config.fields);
}
