/**
 * Runtime executor: op.derive — multi-source read + merge.
 *
 * All backends: run queries per source, merge results in JS.
 * The merge logic is backend-agnostic — only the data fetching differs.
 */
import type {
  DeriveOpConfig,
  MergeStrategy,
  ResolvedEntityConfig,
} from '@lastshotlabs/slingshot-core';
import { toSnakeCase } from '../fieldUtils';
import type { MemoryEntry, MongoModel, PgPool, RedisClient, SqliteDb } from './dbInterfaces';

function mergeResults(
  sourceResults: unknown[][],
  strategy: MergeStrategy,
  flatten?: boolean,
): unknown[] {
  let merged: unknown[];
  switch (strategy) {
    case 'union': {
      const seen = new Set<string>();
      merged = [];
      for (const results of sourceResults) {
        for (const item of results) {
          const key = JSON.stringify(item);
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(item);
          }
        }
      }
      break;
    }
    case 'concat':
      merged = sourceResults.flat();
      break;
    case 'intersect': {
      if (sourceResults.length === 0) return [];
      const sets = sourceResults.map(r => new Set(r.map(x => JSON.stringify(x))));
      merged = sourceResults[0].filter(item => sets.every(s => s.has(JSON.stringify(item))));
      break;
    }
    case 'first':
      merged = sourceResults.find(r => r.length > 0) ?? [];
      break;
    case 'priority': {
      const map = new Map<string, unknown>();
      for (const results of sourceResults) {
        for (const item of results) map.set(JSON.stringify(item), item);
      }
      merged = [...map.values()];
      break;
    }
    default:
      merged = sourceResults.flat();
  }
  return flatten ? merged.flat() : merged;
}

function resolveWhere(
  where: Record<string, string | null>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(where)) {
    if (value === null) resolved[field] = null;
    else if (value.startsWith('param:')) resolved[field] = params[value.slice(6)];
    else resolved[field] = value;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function deriveMemory(
  op: DeriveOpConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
  isVisible: (record: Record<string, unknown>) => boolean,
  pkField: string,
): (params: Record<string, unknown>) => Promise<unknown[]> {
  return params => {
    const sourceResults: unknown[][] = [];
    for (const source of op.sources) {
      const resolved = resolveWhere(source.where, params);
      const results: unknown[] = [];
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        let matches = true;
        for (const [field, target] of Object.entries(resolved)) {
          if (target === null) {
            if (entry.record[field] != null) {
              matches = false;
              break;
            }
          } else if (entry.record[field] !== target) {
            matches = false;
            break;
          }
        }
        if (!matches) continue;
        if (source.traverse) {
          const fk = entry.record[source.traverse.on];
          for (const t of store.values()) {
            if (!isAlive(t) || !isVisible(t.record)) continue;
            if (t.record[pkField] === fk) {
              results.push(t.record[source.traverse.select]);
              break;
            }
          }
        } else if (source.select) {
          results.push(entry.record[source.select]);
        } else {
          results.push({ ...entry.record });
        }
      }
      sourceResults.push(results);
    }
    return Promise.resolve(mergeResults(sourceResults, op.merge, op.flatten));
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

export function deriveSqlite(
  op: DeriveOpConfig,
  config: ResolvedEntityConfig,
  db: SqliteDb,
  table: string,
  ensureTable: () => void,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<unknown[]> {
  return params => {
    ensureTable();
    const sourceResults: unknown[][] = [];
    for (const source of op.sources) {
      const resolved = resolveWhere(source.where, params);
      const conditions: string[] = [];
      const bindValues: unknown[] = [];
      for (const [field, target] of Object.entries(resolved)) {
        const col = toSnakeCase(field);
        if (target === null) conditions.push(`${col} IS NULL`);
        else {
          conditions.push(`${col} = ?`);
          bindValues.push(target);
        }
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db
        .query<Record<string, unknown>>(`SELECT * FROM ${table} ${where}`)
        .all(...bindValues);

      if (source.select) {
        const sel = source.select;
        sourceResults.push(rows.map(r => fromRow(r)[sel]));
      } else {
        sourceResults.push(rows.map(r => fromRow(r)));
      }
    }
    return Promise.resolve(mergeResults(sourceResults, op.merge, op.flatten));
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

export function derivePostgres(
  op: DeriveOpConfig,
  config: ResolvedEntityConfig,
  pool: PgPool,
  table: string,
  ensureTable: () => Promise<void>,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<unknown[]> {
  return async params => {
    await ensureTable();
    const sourceResults: unknown[][] = [];
    for (const source of op.sources) {
      const resolved = resolveWhere(source.where, params);
      const conditions: string[] = [];
      const bindValues: unknown[] = [];
      let pIdx = 0;
      for (const [field, target] of Object.entries(resolved)) {
        const col = toSnakeCase(field);
        if (target === null) conditions.push(`${col} IS NULL`);
        else {
          conditions.push(`${col} = $${++pIdx}`);
          bindValues.push(target);
        }
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await pool.query(`SELECT * FROM ${table} ${where}`, bindValues);

      if (source.select) {
        const sel = source.select;
        sourceResults.push(result.rows.map(r => fromRow(r)[sel]));
      } else {
        sourceResults.push(result.rows.map(r => fromRow(r)));
      }
    }
    return mergeResults(sourceResults, op.merge, op.flatten);
  };
}

// ---------------------------------------------------------------------------
// Mongo
// ---------------------------------------------------------------------------

export function deriveMongo(
  op: DeriveOpConfig,
  config: ResolvedEntityConfig,
  getModel: () => MongoModel,
  fromDoc: (doc: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<unknown[]> {
  return async params => {
    const sourceResults: unknown[][] = [];
    for (const source of op.sources) {
      const resolved = resolveWhere(source.where, params);
      const query: Record<string, unknown> = {};
      for (const [field, target] of Object.entries(resolved)) {
        const mongoField = config.fields[field].primary ? '_id' : field;
        query[mongoField] = target;
      }
      const docs = await getModel().find(query).lean();

      if (source.select) {
        const sel = source.select;
        sourceResults.push(docs.map(d => fromDoc(d)[sel]));
      } else {
        sourceResults.push(docs.map(d => fromDoc(d)));
      }
    }
    return mergeResults(sourceResults, op.merge, op.flatten);
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

export function deriveRedis(
  op: DeriveOpConfig,
  config: ResolvedEntityConfig,
  redis: RedisClient,
  scanAllKeys: () => Promise<string[]>,
  isVisible: (record: Record<string, unknown>) => boolean,
  fromRedisRecord: (raw: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<unknown[]> {
  return async params => {
    const allKeys = await scanAllKeys();
    const allRecords: Array<Record<string, unknown>> = [];
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (isVisible(record)) allRecords.push(record);
    }

    const sourceResults: unknown[][] = [];
    for (const source of op.sources) {
      const resolved = resolveWhere(source.where, params);
      const results: unknown[] = [];
      for (const record of allRecords) {
        let matches = true;
        for (const [field, target] of Object.entries(resolved)) {
          if (target === null) {
            if (record[field] != null) {
              matches = false;
              break;
            }
          } else if (record[field] !== target) {
            matches = false;
            break;
          }
        }
        if (!matches) continue;
        if (source.select) results.push(record[source.select]);
        else results.push({ ...record });
      }
      sourceResults.push(results);
    }
    return mergeResults(sourceResults, op.merge, op.flatten);
  };
}
