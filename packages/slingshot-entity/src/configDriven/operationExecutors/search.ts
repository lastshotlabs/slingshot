/**
 * Runtime executor: `op.search` — full-text search with optional filter and pagination.
 *
 * Each exported function is a per-backend factory. The returned executor signature is:
 * ```ts
 * (query: string, filterParams?: Record<string, unknown>, limit?: number, cursor?: string) => Promise<unknown>
 * ```
 *
 * **Text search strategy per backend:**
 * - Memory / Redis: JavaScript `String.prototype.includes()` across `op.fields` values
 *   (case-insensitive). O(n) in the number of records.
 * - SQLite: `WHERE (col1 LIKE ? OR col2 LIKE ?)` with `%query%` wildcards.
 * - Postgres: `WHERE to_tsvector('english', ...) @@ plainto_tsquery('english', $1)`.
 *   Requires a `tsvector` index on the search fields for production performance.
 * - Mongo: `{ $text: { $search: query } }`. Requires a `text` index on `op.fields`.
 *
 * **Filter:** `op.filter` is applied in JavaScript after the text search results are
 * fetched from the DB. Supports the full `FilterExpression` DSL including `$and`/`$or`
 * and `param:` references resolved from `filterParams`.
 *
 * **Pagination:** When `op.paginate` is `true`, results are wrapped as:
 * `{ items, nextCursor, hasMore }` using an offset-based cursor. When `false` or
 * `undefined`, results are returned as a plain array (sliced to `limit` if provided).
 *
 * **Cursor encoding:** Cursors are base64-encoded JSON objects (`{ offset: number }`).
 * Invalid cursors are silently reset to offset 0.
 */
import type { FilterExpression, SearchOpConfig } from '@lastshotlabs/slingshot-core';
import { decodeCursor, encodeCursor, toSnakeCase } from '../fieldUtils';
import { evaluateFilter } from '../filterEvaluator';
import type { MemoryEntry, MongoModel, PgPool, RedisClient, SqliteDb } from './dbInterfaces';

function paginateResults(
  items: Array<Record<string, unknown>>,
  paginate: boolean | undefined,
  limit?: number,
  cursor?: string,
): unknown {
  if (!paginate) {
    return limit ? items.slice(0, limit) : items;
  }
  const effectiveLimit = limit ?? 50;
  let startIdx = 0;
  if (cursor) {
    try {
      const decoded = decodeCursor(cursor);
      startIdx = typeof decoded.offset === 'number' ? decoded.offset : 0;
    } catch {
      startIdx = 0;
    }
  }
  const page = items.slice(startIdx, startIdx + effectiveLimit + 1);
  const hasMore = page.length > effectiveLimit;
  const resultItems = page.slice(0, effectiveLimit);
  const nextCursor = hasMore ? encodeCursor({ offset: startIdx + effectiveLimit }) : undefined;
  return { items: resultItems, nextCursor, hasMore };
}

function applyFilter(
  items: Array<Record<string, unknown>>,
  filter: FilterExpression | undefined,
  params: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (!filter) return items;
  return items.filter(item => evaluateFilter(item, filter, params));
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Create a search executor for the in-memory store.
 *
 * Scans the full store, applies TTL and visibility checks, then does a
 * case-insensitive substring match across all `op.fields`. After text filtering,
 * the JS filter (`op.filter`) is applied, then results are paginated.
 *
 * @param op - Search operation config with `fields`, optional `filter`, and `paginate`.
 * @param store - The entity's in-memory store map.
 * @param isAlive - TTL check for each entry.
 * @param isVisible - Tenant visibility check.
 * @returns An async search function.
 */
export function searchMemory(
  op: SearchOpConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
  isVisible: (record: Record<string, unknown>) => boolean,
): (
  query: string,
  filterParams?: Record<string, unknown>,
  limit?: number,
  cursor?: string,
) => Promise<unknown> {
  const fields = op.fields;
  return (query, filterParams, limit, cursor) => {
    const q = query.toLowerCase();
    const results: Array<Record<string, unknown>> = [];
    for (const entry of store.values()) {
      if (!isAlive(entry) || !isVisible(entry.record)) continue;
      if (
        fields.some(f => {
          const val = entry.record[f];
          const str =
            typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean'
              ? String(val)
              : '';
          return str.toLowerCase().includes(q);
        })
      ) {
        results.push({ ...entry.record });
      }
    }
    const filtered = applyFilter(results, op.filter, filterParams ?? {});
    return Promise.resolve(paginateResults(filtered, op.paginate, limit, cursor));
  };
}

// ---------------------------------------------------------------------------
// SQLite — text search via LIKE, then JS filter for complex expressions
// ---------------------------------------------------------------------------

/**
 * Create a search executor for the SQLite store.
 *
 * Generates `WHERE (col1 LIKE ? OR col2 LIKE ?)` with `%query%` for each field in
 * `op.fields`. All results are fetched, converted via `fromRow`, then the JS filter
 * is applied before pagination.
 *
 * @param op - Search operation config.
 * @param db - Bun SQLite database handle.
 * @param table - SQL table name.
 * @param ensureTable - Idempotent table-creation function.
 * @param fromRow - Converts a raw SQLite row to a canonical record.
 * @returns An async search function.
 */
export function searchSqlite(
  op: SearchOpConfig,
  db: SqliteDb,
  table: string,
  ensureTable: () => void,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (
  query: string,
  filterParams?: Record<string, unknown>,
  limit?: number,
  cursor?: string,
) => Promise<unknown> {
  const likeClauses = op.fields.map(f => `${toSnakeCase(f)} LIKE ?`).join(' OR ');
  return (query, filterParams, limit, cursor) => {
    ensureTable();
    const likeParams = op.fields.map(() => `%${query}%`);
    const rows = db
      .query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE (${likeClauses})`)
      .all(...likeParams);
    const items = rows.map(r => fromRow(r));
    const filtered = applyFilter(items, op.filter, filterParams ?? {});
    return Promise.resolve(paginateResults(filtered, op.paginate, limit, cursor));
  };
}

// ---------------------------------------------------------------------------
// Postgres — text search via tsvector, then JS filter for complex expressions
// ---------------------------------------------------------------------------

/**
 * Create a search executor for the Postgres store.
 *
 * Concatenates `op.fields` (with `coalesce(..., '')`) into a single `tsvector`
 * and matches against `plainto_tsquery('english', $1)`. All matching rows are
 * fetched, converted via `fromRow`, then the JS filter is applied before pagination.
 * A GIN index on the search fields is recommended for production performance.
 *
 * @param op - Search operation config.
 * @param pool - Postgres connection pool.
 * @param table - SQL table name.
 * @param ensureTable - Async idempotent table-creation function.
 * @param fromRow - Converts a raw Postgres row to a canonical record.
 * @returns An async search function.
 */
export function searchPostgres(
  op: SearchOpConfig,
  pool: PgPool,
  table: string,
  ensureTable: () => Promise<void>,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (
  query: string,
  filterParams?: Record<string, unknown>,
  limit?: number,
  cursor?: string,
) => Promise<unknown> {
  const tsvectorCols = op.fields.map(f => `coalesce(${toSnakeCase(f)}, '')`).join(" || ' ' || ");
  return async (query, filterParams, limit, cursor) => {
    await ensureTable();
    const result = await pool.query(
      `SELECT * FROM ${table} WHERE to_tsvector('english', ${tsvectorCols}) @@ plainto_tsquery('english', $1)`,
      [query],
    );
    const items = result.rows.map(r => fromRow(r));
    const filtered = applyFilter(items, op.filter, filterParams ?? {});
    return paginateResults(filtered, op.paginate, limit, cursor);
  };
}

// ---------------------------------------------------------------------------
// Mongo — text search via $text, then JS filter for complex expressions
// ---------------------------------------------------------------------------

/**
 * Create a search executor for the MongoDB store.
 *
 * Uses `{ $text: { $search: query } }` — requires a `text` index on `op.fields`
 * in the Mongoose schema. All matching documents are fetched via `find().lean()`,
 * converted via `fromDoc`, then the JS filter is applied before pagination.
 *
 * @param op - Search operation config.
 * @param getModel - Lazy getter returning the Mongoose model.
 * @param fromDoc - Converts a raw Mongoose lean doc to a canonical record.
 * @returns An async search function.
 */
export function searchMongo(
  op: SearchOpConfig,
  getModel: () => MongoModel,
  fromDoc: (doc: Record<string, unknown>) => Record<string, unknown>,
): (
  query: string,
  filterParams?: Record<string, unknown>,
  limit?: number,
  cursor?: string,
) => Promise<unknown> {
  return async (query, filterParams, limit, cursor) => {
    const docs = await getModel()
      .find({ $text: { $search: query } })
      .lean();
    const items = docs.map(d => fromDoc(d));
    const filtered = applyFilter(items, op.filter, filterParams ?? {});
    return paginateResults(filtered, op.paginate, limit, cursor);
  };
}

// ---------------------------------------------------------------------------
// Redis — text search in JS, then filter
// ---------------------------------------------------------------------------

/**
 * Create a search executor for the Redis store.
 *
 * Functionally identical to the memory executor: all keys are scanned, each record
 * is deserialised, visibility is checked, and a case-insensitive substring match is
 * applied across `op.fields` in JavaScript. O(n) in the number of records.
 *
 * @param op - Search operation config.
 * @param redis - ioredis client instance.
 * @param scanAllKeys - Returns all key strings for this entity's key space.
 * @param isVisible - Tenant visibility check.
 * @param fromRedisRecord - Deserialises a raw Redis record into the canonical shape.
 * @returns An async search function.
 */
export function searchRedis(
  op: SearchOpConfig,
  redis: RedisClient,
  scanAllKeys: () => Promise<string[]>,
  isVisible: (record: Record<string, unknown>) => boolean,
  fromRedisRecord: (raw: Record<string, unknown>) => Record<string, unknown>,
): (
  query: string,
  filterParams?: Record<string, unknown>,
  limit?: number,
  cursor?: string,
) => Promise<unknown> {
  const fields = op.fields;
  return async (query, filterParams, limit, cursor) => {
    const q = query.toLowerCase();
    const allKeys = await scanAllKeys();
    const results: Array<Record<string, unknown>> = [];
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(record)) continue;
      if (
        fields.some(f => {
          const val = record[f];
          const str =
            typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean'
              ? String(val)
              : '';
          return str.toLowerCase().includes(q);
        })
      ) {
        results.push({ ...record });
      }
    }
    const filtered = applyFilter(results, op.filter, filterParams ?? {});
    return paginateResults(filtered, op.paginate, limit, cursor);
  };
}
