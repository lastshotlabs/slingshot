/**
 * Runtime executor: `op.lookup` — find records by non-primary key field(s).
 *
 * Each exported function is a per-backend factory. The returned executor's
 * return type depends on `op.returns`:
 * - `'one'` — returns the first matching record as `Record<string, unknown> | null`.
 * - `'many'` (default) — returns a paginated list:
 *   `{ items: Record<string, unknown>[], nextCursor: string | undefined, hasMore: boolean }`.
 *
 * **Field matching:** `op.fields` maps entity field names to either:
 * - `'param:x'` — value resolved from the runtime `params` argument.
 *   The constraint behavior depends on what the caller passed for `x`:
 *   - **omitted / `undefined`** — constraint is dropped (wildcard). Lets
 *     callers skip optional fields like `tenantId` in single-tenant
 *     deploys without forcing them to pass `null`.
 *   - **`null`** — matches records where the field is null
 *     (`IS NULL` in SQL; `record[field] === null` in JS; Mongo `null`
 *     also matches missing fields).
 *   - **primitive value** — exact match.
 * - A literal string value — always matched directly. Config-time
 *   constants are not subject to the omit/null rules above.
 *
 * **Sorting (memory only):** When `op.returns === 'many'`, results are sorted by
 * `cursorFields` in `defaultSortDir` order before slicing to `limit`. SQL and Mongo
 * backends do not apply client-side sorting — rely on DB-level `ORDER BY` or index
 * ordering for consistent pagination.
 *
 * **Cursor pagination:** The `'many'` result includes `nextCursor` and `hasMore` fields.
 * For SQL/Mongo backends the cursor is always `undefined` (offset pagination not yet
 * implemented). For the memory backend the cursor is opaque but unused in the current
 * slice-based implementation.
 *
 * No casts — TypeScript enforces all adapter internals at factory call sites.
 */
import type { LookupOpConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { compareForSort, toSnakeCase } from '../fieldUtils';
import type { MemoryEntry, MongoModel, PgPool, RedisClient, SqliteDb } from './dbInterfaces';

function isParamRef(value: string | number | boolean): value is string {
  return typeof value === 'string' && value.startsWith('param:');
}

function toSqlLiteral(value: string | number | boolean): string {
  return typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value);
}

/**
 * Resolve a `param:x` field reference against the runtime params object.
 *
 * Returns one of:
 * - `{ kind: 'omit' }` — the caller did not supply the param (key missing
 *   or value is `undefined`). The matcher should skip this constraint
 *   entirely. Lets callers omit optional fields like `tenantId` in
 *   single-tenant deploys without forcing them to pass `null`.
 * - `{ kind: 'null' }` — the caller passed `null`. The matcher should
 *   match records where the field is null (`IS NULL` in SQL,
 *   `record[field] === null` in JS).
 * - `{ kind: 'value', value }` — the caller passed a primitive. Exact match.
 *
 * Literal field values (non-`param:` constants on the op definition) are
 * always exact-match — they're config-time, not caller-supplied.
 */
type ResolvedConstraint =
  | { kind: 'omit' }
  | { kind: 'null' }
  | { kind: 'value'; value: string | number | boolean };

function resolveParam(
  params: Record<string, unknown>,
  paramName: string,
): ResolvedConstraint {
  if (!(paramName in params)) return { kind: 'omit' };
  const v = params[paramName];
  if (v === undefined) return { kind: 'omit' };
  if (v === null) return { kind: 'null' };
  return { kind: 'value', value: v as string | number | boolean };
}

/**
 * Create a lookup executor for the in-memory store.
 *
 * Scans the full store, skipping expired and tenant-invisible entries, then
 * matches on `op.fields`. When `op.returns === 'one'`, returns on the first
 * match. When `'many'`, collects all matches, sorts by `cursorFields`, and
 * slices to `min(defaultLimit, maxLimit)`.
 *
 * @param op - Lookup operation config.
 * @param config - Resolved entity config.
 * @param store - The entity's in-memory store map.
 * @param isAlive - TTL check for each entry.
 * @param isVisible - Tenant visibility check.
 * @param cursorFields - Ordered field names used for sorting `'many'` results.
 * @param defaultSortDir - Default sort direction (`'asc'` or `'desc'`).
 * @param defaultLimit - Default page size for `'many'` results.
 * @param maxLimit - Hard upper bound on the page size.
 * @returns An async function `(params) => Promise<unknown>`.
 */
export function lookupMemory(
  op: LookupOpConfig,
  config: ResolvedEntityConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
  isVisible: (record: Record<string, unknown>) => boolean,
  cursorFields: readonly string[],
  defaultSortDir: 'asc' | 'desc',
  defaultLimit: number,
  maxLimit: number,
): (params: Record<string, unknown>) => Promise<unknown> {
  const fieldEntries = Object.entries(op.fields);

  function matchesRecord(
    record: Record<string, unknown>,
    resolved: Record<string, unknown>,
  ): boolean {
    for (const [field, value] of fieldEntries) {
      if (isParamRef(value)) {
        const c = resolveParam(resolved, value.slice(6));
        if (c.kind === 'omit') continue;
        if (c.kind === 'null') {
          if (record[field] !== null && record[field] !== undefined) return false;
        } else {
          if (record[field] !== c.value) return false;
        }
      } else {
        // Literal config-time constant — always exact match.
        if (record[field] !== value) return false;
      }
    }
    return true;
  }

  if (op.returns === 'one') {
    return params => {
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        if (matchesRecord(entry.record, params)) return Promise.resolve({ ...entry.record });
      }
      return Promise.resolve(null);
    };
  }

  return params => {
    const results: Array<Record<string, unknown>> = [];
    for (const entry of store.values()) {
      if (!isAlive(entry) || !isVisible(entry.record)) continue;
      if (matchesRecord(entry.record, params)) results.push({ ...entry.record });
    }
    results.sort((a, b) => compareForSort(a, b, cursorFields, defaultSortDir));
    const limit = Math.min(defaultLimit, maxLimit);
    return Promise.resolve({
      items: results.slice(0, limit),
      nextCursor: undefined,
      hasMore: results.length > limit,
    });
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Create a lookup executor for the SQLite store.
 *
 * Builds a `SELECT * FROM {table} WHERE {conditions}` query. For `'one'`, appends
 * `LIMIT 1`. Parameters are bound as `?` positional values. Returns `null` when no
 * matching row is found for `'one'`; returns an empty `items` array for `'many'`.
 *
 * @param op - Lookup operation config.
 * @param config - Resolved entity config.
 * @param db - Bun SQLite database handle.
 * @param table - SQL table name.
 * @param ensureTable - Idempotent table-creation function.
 * @param fromRow - Converts a raw SQLite row to a canonical record.
 * @returns An async function `(params) => Promise<unknown>`.
 */
export function lookupSqlite(
  op: LookupOpConfig,
  config: ResolvedEntityConfig,
  db: SqliteDb,
  table: string,
  ensureTable: () => void,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<unknown> {
  const fieldEntries = Object.entries(op.fields);

  // WHERE clause is built per-call: param presence at call time decides
  // whether each constraint contributes a `field = ?`, an `IS NULL`, or
  // is omitted entirely. Literal field values are still embedded
  // directly so they don't need a per-call rebuild.
  function buildClause(params: Record<string, unknown>): { where: string; binds: unknown[] } {
    const conditions: string[] = [];
    const binds: unknown[] = [];
    for (const [field, value] of fieldEntries) {
      const col = toSnakeCase(field);
      if (isParamRef(value)) {
        const c = resolveParam(params, value.slice(6));
        if (c.kind === 'omit') continue;
        if (c.kind === 'null') {
          conditions.push(`${col} IS NULL`);
        } else {
          conditions.push(`${col} = ?`);
          binds.push(c.value);
        }
      } else {
        conditions.push(`${col} = ${toSqlLiteral(value)}`);
      }
    }
    // Empty WHERE (all params omitted, all constants resolved) → match all.
    return { where: conditions.length === 0 ? '1=1' : conditions.join(' AND '), binds };
  }

  if (op.returns === 'one') {
    return params => {
      ensureTable();
      const { where, binds } = buildClause(params);
      const row = db
        .query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${where} LIMIT 1`)
        .get(...binds);
      return Promise.resolve(row ? fromRow(row) : null);
    };
  }

  return params => {
    ensureTable();
    const { where, binds } = buildClause(params);
    const rows = db
      .query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${where}`)
      .all(...binds);
    return Promise.resolve({
      items: rows.map(r => fromRow(r)),
      nextCursor: undefined,
      hasMore: false,
    });
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/**
 * Create a lookup executor for the Postgres store.
 *
 * Equivalent to the SQLite executor but uses `$N` positional parameters.
 * Literal field values are embedded directly in the SQL string (safe — they are
 * config-time constants, not user input). Param values are properly parameterised.
 *
 * @param op - Lookup operation config.
 * @param config - Resolved entity config.
 * @param pool - Postgres connection pool.
 * @param table - SQL table name.
 * @param ensureTable - Async idempotent table-creation function.
 * @param fromRow - Converts a raw Postgres row to a canonical record.
 * @returns An async function `(params) => Promise<unknown>`.
 */
export function lookupPostgres(
  op: LookupOpConfig,
  config: ResolvedEntityConfig,
  pool: PgPool,
  table: string,
  ensureTable: () => Promise<void>,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<unknown> {
  const fieldEntries = Object.entries(op.fields);

  // Per-call WHERE clause — same semantics as the SQLite executor; see
  // its comment for rationale.
  function buildClause(params: Record<string, unknown>): { where: string; binds: unknown[] } {
    const conditions: string[] = [];
    const binds: unknown[] = [];
    let paramIdx = 0;
    for (const [field, value] of fieldEntries) {
      const col = toSnakeCase(field);
      if (isParamRef(value)) {
        const c = resolveParam(params, value.slice(6));
        if (c.kind === 'omit') continue;
        if (c.kind === 'null') {
          conditions.push(`${col} IS NULL`);
        } else {
          conditions.push(`${col} = $${++paramIdx}`);
          binds.push(c.value);
        }
      } else {
        conditions.push(`${col} = ${toSqlLiteral(value)}`);
      }
    }
    return { where: conditions.length === 0 ? 'TRUE' : conditions.join(' AND '), binds };
  }

  if (op.returns === 'one') {
    return async params => {
      await ensureTable();
      const { where, binds } = buildClause(params);
      const result = await pool.query(`SELECT * FROM ${table} WHERE ${where} LIMIT 1`, binds);
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    };
  }

  return async params => {
    await ensureTable();
    const { where, binds } = buildClause(params);
    const result = await pool.query(`SELECT * FROM ${table} WHERE ${where}`, binds);
    return { items: result.rows.map(r => fromRow(r)), nextCursor: undefined, hasMore: false };
  };
}

// ---------------------------------------------------------------------------
// Mongo
// ---------------------------------------------------------------------------

/**
 * Create a lookup executor for the MongoDB store.
 *
 * Builds a Mongo query from `op.fields` (mapping primary-key fields to `_id`).
 * For `'one'`, calls `findOne().lean()`. For `'many'`, calls `find().lean()`.
 * Returns `null` / empty `items` when no documents match.
 *
 * @param op - Lookup operation config.
 * @param config - Resolved entity config (provides `fields` metadata for PK detection).
 * @param getModel - Lazy getter returning the Mongoose model.
 * @param fromDoc - Converts a raw Mongoose lean doc to a canonical record.
 * @returns An async function `(params) => Promise<unknown>`.
 */
export function lookupMongo(
  op: LookupOpConfig,
  config: ResolvedEntityConfig,
  getModel: () => MongoModel,
  fromDoc: (doc: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<unknown> {
  const fieldEntries = Object.entries(op.fields);

  function buildQuery(params: Record<string, unknown>): Record<string, unknown> {
    const query: Record<string, unknown> = {};
    for (const [field, value] of fieldEntries) {
      const mongoField = config.fields[field].primary ? config._storageFields.mongoPkField : field;
      if (isParamRef(value)) {
        const c = resolveParam(params, value.slice(6));
        if (c.kind === 'omit') continue;
        // Mongo: matching `null` also matches docs missing the field, which
        // is what we want for "single-tenant tenantId" type lookups.
        query[mongoField] = c.kind === 'null' ? null : c.value;
      } else {
        query[mongoField] = value;
      }
    }
    return query;
  }

  if (op.returns === 'one') {
    return async params => {
      const doc = await getModel().findOne(buildQuery(params)).lean();
      return doc ? fromDoc(doc) : null;
    };
  }

  return async params => {
    const docs = await getModel().find(buildQuery(params)).lean();
    return { items: docs.map(d => fromDoc(d)), nextCursor: undefined, hasMore: false };
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * Create a lookup executor for the Redis store.
 *
 * Scans all keys, deserialises each record, applies visibility check, then
 * matches on `op.fields`. O(n) in the number of records. For `'one'`, returns
 * on the first match; for `'many'`, collects all matches. No sorting is applied.
 *
 * @param op - Lookup operation config.
 * @param config - Resolved entity config.
 * @param redis - ioredis client instance.
 * @param scanAllKeys - Returns all key strings for this entity's key space.
 * @param isVisible - Tenant visibility check.
 * @param fromRedisRecord - Deserialises a raw Redis record into the canonical shape.
 * @returns An async function `(params) => Promise<unknown>`.
 */
export function lookupRedis(
  op: LookupOpConfig,
  config: ResolvedEntityConfig,
  redis: RedisClient,
  scanAllKeys: () => Promise<string[]>,
  isVisible: (record: Record<string, unknown>) => boolean,
  fromRedisRecord: (raw: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<unknown> {
  const fieldEntries = Object.entries(op.fields);

  function matchesRecord(
    record: Record<string, unknown>,
    resolved: Record<string, unknown>,
  ): boolean {
    for (const [field, value] of fieldEntries) {
      if (isParamRef(value)) {
        const c = resolveParam(resolved, value.slice(6));
        if (c.kind === 'omit') continue;
        if (c.kind === 'null') {
          if (record[field] !== null && record[field] !== undefined) return false;
        } else {
          if (record[field] !== c.value) return false;
        }
      } else {
        if (record[field] !== value) return false;
      }
    }
    return true;
  }

  if (op.returns === 'one') {
    return async params => {
      const allKeys = await scanAllKeys();
      for (const key of allKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
        if (!isVisible(record)) continue;
        if (matchesRecord(record, params)) return { ...record };
      }
      return null;
    };
  }

  return async params => {
    const allKeys = await scanAllKeys();
    const results: Array<Record<string, unknown>> = [];
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(record)) continue;
      if (matchesRecord(record, params)) results.push({ ...record });
    }
    return { items: results, nextCursor: undefined, hasMore: false };
  };
}
