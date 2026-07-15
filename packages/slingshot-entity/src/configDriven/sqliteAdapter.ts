/**
 * Config-driven SQLite adapter generator.
 *
 * Auto-creates the table on first use, generates indices for indexed fields,
 * and handles domain ↔ storage mapping including dates, JSON, booleans, etc.
 * Supports soft-delete, cursor pagination, TTL, and tenant scoping.
 */
import type {
  EntityAdapter,
  OperationConfig,
  ResolvedEntityConfig,
} from '@lastshotlabs/slingshot-core';
import {
  applyDefaults,
  applyOnUpdate,
  buildCursorForRecord,
  coerceToDate,
  decodeCursor,
  fromSqliteRow,
  quoteSqliteIdent,
  sqliteColumnType,
  storageName,
  toSnakeCase,
  toSqliteRow,
} from './fieldUtils';
import { resolveListFilter } from './listFilter';
import type { SqliteDb } from './operationExecutors/dbInterfaces';
import { buildSqliteOperations } from './sqliteOperationWiring';

function runSqliteImmediateTransaction(db: SqliteDb, fn: () => void): void {
  let inTransaction = false;
  try {
    db.run('PRAGMA busy_timeout = 5000');
    db.run('BEGIN IMMEDIATE');
    inTransaction = true;
    fn();
    db.run('COMMIT');
    inTransaction = false;
  } catch (error) {
    if (inTransaction) {
      try {
        db.run('ROLLBACK');
      } catch {
        // Preserve the original bootstrap failure.
      }
    }
    throw error;
  }
}

/**
 * Create a SQLite-backed {@link EntityAdapter} for the given entity config.
 *
 * Auto-creates the table and indexes on first use. Handles domain ↔ storage
 * mapping including dates (epoch ms), JSON (serialised text), booleans (0/1),
 * and snake_case column names. Supports soft-delete, cursor pagination, TTL
 * (via a configurable expiry column), and tenant-scoped list operations.
 *
 * @param db - The SQLite database instance (must implement {@link SqliteDb}).
 * @param config - The resolved entity config with fields, indexes, and conventions.
 * @param operations - Optional named operation configs for the entity.
 * @returns An {@link EntityAdapter} with CRUD methods backed by SQLite.
 *
 * @see {@link EntityStorageFieldMap} for customising the TTL column name.
 */
export function createSqliteEntityAdapter<Entity, CreateInput, UpdateInput>(
  db: SqliteDb,
  config: ResolvedEntityConfig,
  operations?: Record<string, OperationConfig>,
): EntityAdapter<Entity, CreateInput, UpdateInput> & Record<string, unknown> {
  // Quote the table identifier ONCE, here, so every statement below is safe by
  // construction rather than by each author remembering.
  //
  // `_storageName` is `${namespace}_${plural}`, and a namespace is free-form. Every
  // package in-tree happened to use a bare word (`chat`, `assets`, `community`) —
  // until `slingshot-ai` used its own package name and produced the table
  // `slingshot-ai_aiUsageRecords`. Interpolated unquoted, SQLite reads the hyphen
  // as a minus operator: `near "-": syntax error`, on CREATE and on every write.
  //
  // The consequence was not cosmetic. That table is the AI **spend ledger**, and
  // the pre-flight budget guard hydrates from it at boot — a guard that exists to
  // stop a runaway LLM loop spending real money. A ledger that silently fails to
  // persist resets the budget on every restart, which is precisely the case it was
  // built to survive. Quoting is the fix; the hyphen was never the mistake.
  const rawTable = storageName(config, 'sqlite');
  const table = quoteSqliteIdent(rawTable);
  const customAutoDefault = config._conventions?.autoDefault;
  const customOnUpdate = config._conventions?.onUpdate;
  const pkField = config._pkField;
  const pkColumn = toSnakeCase(pkField);
  const ttlSeconds = config.ttl?.defaultSeconds;
  const ttlColumn = config._storageFields.ttlField;
  let initialized = false;

  const defaultLimit = config.pagination?.defaultLimit ?? 50;
  const maxLimit = config.pagination?.maxLimit ?? 200;
  const cursorFields = config.pagination?.cursor.fields ?? [pkField];
  const defaultSortDir = config.defaultSort?.direction ?? 'asc';

  function ensureTable(): void {
    if (initialized) return;
    runSqliteImmediateTransaction(db, () => {
      const cols: string[] = [];
      for (const [name, def] of Object.entries(config.fields)) {
        const col = toSnakeCase(name);
        const sqlType = sqliteColumnType(def.type);
        const notNull = !def.optional && !def.primary ? ' NOT NULL' : '';
        const pk = def.primary ? ' PRIMARY KEY NOT NULL' : '';
        cols.push(`${col} ${sqlType}${pk}${notNull}`);
      }

      if (ttlSeconds) {
        cols.push(`${ttlColumn} INTEGER NOT NULL`);
      }

      db.run(`CREATE TABLE IF NOT EXISTS ${table} (\n  ${cols.join(',\n  ')}\n)`);

      // Reconcile drift: an EXISTING table gains any column the entity has and
      // it lacks. `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table,
      // so without this every deployed database breaks on the first write that
      // touches a field added after its table was created (the
      // `host_absent_since` lesson: fresh installs fine, every live deployment
      // 500ing silently). Additive only — never drop, never retype. Constraints
      // ALTER TABLE cannot honour on a populated table (PRIMARY KEY, UNIQUE,
      // NOT NULL without default) are stripped, matching the generated-code
      // path in `generators/sqlite.ts`.
      const existingCols = new Set(
        (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          row => row.name,
        ),
      );
      for (const [name, def] of Object.entries(config.fields)) {
        const col = toSnakeCase(name);
        if (existingCols.has(col)) continue;
        db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${sqliteColumnType(def.type)}`);
      }
      if (ttlSeconds && !existingCols.has(ttlColumn)) {
        db.run(`ALTER TABLE ${table} ADD COLUMN ${ttlColumn} INTEGER`);
      }

      // Compound indexes
      if (config.indexes) {
        for (let i = 0; i < config.indexes.length; i++) {
          const idx = config.indexes[i];
          const colList = idx.fields.map(f => toSnakeCase(f)).join(', ');
          const unique = idx.unique ? 'UNIQUE ' : '';
          const idxName = quoteSqliteIdent(`idx_${rawTable}_${i}`);
          db.run(`CREATE ${unique}INDEX IF NOT EXISTS ${idxName} ON ${table} (${colList})`);
        }
      }

      // Unique constraints
      if (config.uniques) {
        for (let i = 0; i < config.uniques.length; i++) {
          const uq = config.uniques[i];
          const colList = uq.fields.map(f => toSnakeCase(f)).join(', ');
          const uidxName = quoteSqliteIdent(`uidx_${rawTable}_${i}`);
          db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${uidxName} ON ${table} (${colList})`);
        }
      }
    });

    initialized = true;
  }

  function expiresAt(): number {
    if (!ttlSeconds) throw new Error('expiresAt called without ttlSeconds configured');
    return Date.now() + ttlSeconds * 1000;
  }

  function pruneExpired(): void {
    if (!ttlSeconds) return;
    db.run(`DELETE FROM ${table} WHERE ${ttlColumn} < ?`, [Date.now()]);
  }

  function appendFilterConditions(
    filter: Record<string, unknown> | undefined,
    conditions: string[],
    params: unknown[],
  ): void {
    if (!filter) return;

    for (const [key, val] of Object.entries(filter)) {
      if (val === undefined) continue;
      if (key === 'limit' || key === 'cursor' || key === 'sortDir') continue;
      if (!(key in config.fields)) continue;

      const col = toSnakeCase(key);
      const def = config.fields[key];
      if (def.type === 'json' || def.type === 'string[]') {
        conditions.push(`${col} = ?`);
        params.push(JSON.stringify(val));
      } else if (def.type === 'date') {
        conditions.push(`${col} = ?`);
        params.push(val instanceof Date ? val.getTime() : val);
      } else if (def.type === 'boolean') {
        conditions.push(`${col} = ?`);
        params.push(val ? 1 : 0);
      } else {
        conditions.push(`${col} = ?`);
        params.push(val);
      }
    }
  }

  return {
    create(input) {
      ensureTable();
      pruneExpired();

      const record = applyDefaults(
        input as Record<string, unknown>,
        config.fields,
        customAutoDefault,
      );
      const row = toSqliteRow(record, config.fields);
      if (ttlSeconds) row[ttlColumn] = expiresAt();

      const columns = Object.keys(row);
      const placeholders = columns.map(() => '?').join(', ');
      const values = columns.map(c => row[c]);

      db.run(
        `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
        values,
      );

      return Promise.resolve({ ...record } as unknown as Entity);
    },

    getById(id, filter) {
      ensureTable();
      const conditions = [`${pkColumn} = ?`];
      const params: unknown[] = [id];
      appendFilterConditions(filter, conditions, params);
      if (config.softDelete) {
        const col = toSnakeCase(config.softDelete.field);
        if ('value' in config.softDelete) {
          conditions.push(`${col} != ?`);
          params.push(config.softDelete.value);
        } else {
          conditions.push(`${col} IS NULL`);
        }
      }
      if (ttlSeconds) {
        conditions.push(`${ttlColumn} > ?`);
        params.push(Date.now());
      }
      const where = `WHERE ${conditions.join(' AND ')}`;

      const row = db
        .query<Record<string, unknown>>(`SELECT * FROM ${table} ${where}`)
        .get(...params);
      if (!row) return Promise.resolve(null);
      return Promise.resolve(fromSqliteRow(row, config.fields) as Entity);
    },

    update(id, input, filter) {
      ensureTable();

      const conditions = [`${pkColumn} = ?`];
      const checkParams: unknown[] = [id];
      appendFilterConditions(filter, conditions, checkParams);
      if (config.softDelete) {
        const col = toSnakeCase(config.softDelete.field);
        if ('value' in config.softDelete) {
          conditions.push(`${col} != ?`);
          checkParams.push(config.softDelete.value);
        } else {
          conditions.push(`${col} IS NULL`);
        }
      }
      if (ttlSeconds) {
        conditions.push(`${ttlColumn} > ?`);
        checkParams.push(Date.now());
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const existing = db
        .query<Record<string, unknown>>(`SELECT * FROM ${table} ${where}`)
        .get(...checkParams);
      if (!existing) {
        return Promise.resolve(null);
      }

      const updatePayload = applyOnUpdate(
        input as Record<string, unknown>,
        config.fields,
        customOnUpdate,
      );
      const partial = toSqliteRow(updatePayload, config.fields);
      if (ttlSeconds) partial[ttlColumn] = expiresAt();

      const entries = Object.entries(partial);
      if (entries.length === 0) {
        return Promise.resolve(fromSqliteRow(existing, config.fields) as Entity);
      }

      const setClauses = entries.map(([col]) => `${col} = ?`).join(', ');
      const values = [...entries.map(([, v]) => v), ...checkParams];

      db.run(`UPDATE ${table} SET ${setClauses} ${where}`, values);

      // Read back the updated record
      const updated = db
        .query<Record<string, unknown>>(`SELECT * FROM ${table} ${where}`)
        .get(...checkParams);
      if (!updated) return Promise.resolve(null);
      return Promise.resolve(fromSqliteRow(updated, config.fields) as Entity);
    },

    delete(id, filter) {
      ensureTable();

      const conditions = [`${pkColumn} = ?`];
      const params: unknown[] = [id];
      appendFilterConditions(filter, conditions, params);
      if (config.softDelete) {
        const col = toSnakeCase(config.softDelete.field);
        if ('value' in config.softDelete) {
          conditions.push(`${col} != ?`);
          params.push(config.softDelete.value);
        } else {
          conditions.push(`${col} IS NULL`);
        }
      }
      if (ttlSeconds) {
        conditions.push(`${ttlColumn} > ?`);
        params.push(Date.now());
      }
      const where = `WHERE ${conditions.join(' AND ')}`;

      if (config.softDelete) {
        const sdCol = toSnakeCase(config.softDelete.field);
        const onUpdatePayload = applyOnUpdate({}, config.fields, customOnUpdate);
        const partial = toSqliteRow(onUpdatePayload, config.fields);
        partial[sdCol] =
          'value' in config.softDelete ? config.softDelete.value : new Date().toISOString();

        const entries = Object.entries(partial);
        const setClauses = entries.map(([col]) => `${col} = ?`).join(', ');
        const values = [...entries.map(([, v]) => v), ...params];

        const result = db.run(`UPDATE ${table} SET ${setClauses} ${where}`, values);
        return Promise.resolve(result.changes > 0);
      } else {
        const result = db.run(`DELETE FROM ${table} ${where}`, params);
        return Promise.resolve(result.changes > 0);
      }
    },

    list(opts) {
      ensureTable();

      const sortDir = opts?.sortDir ?? defaultSortDir;
      const rawLimit = opts?.limit ?? defaultLimit;
      const limit = Math.min(rawLimit, maxLimit);
      const filter = resolveListFilter(opts as Record<string, unknown> | undefined);

      const conditions: string[] = [];
      const params: unknown[] = [];

      // Soft-delete exclusion
      if (config.softDelete) {
        const col = toSnakeCase(config.softDelete.field);
        if ('value' in config.softDelete) {
          conditions.push(`${col} != ?`);
          params.push(config.softDelete.value);
        } else {
          conditions.push(`${col} IS NULL`);
        }
      }

      // TTL check
      if (ttlSeconds) {
        conditions.push(`${ttlColumn} > ?`);
        params.push(Date.now());
      }

      // Filter parameters
      if (filter) {
        for (const [key, val] of Object.entries(filter)) {
          if (val === undefined) continue;
          if (!(key in config.fields)) continue;

          const col = toSnakeCase(key);
          const def = config.fields[key];
          if (def.type === 'json' || def.type === 'string[]') {
            conditions.push(`${col} = ?`);
            params.push(JSON.stringify(val));
          } else if (def.type === 'date') {
            conditions.push(`${col} = ?`);
            params.push(val instanceof Date ? val.getTime() : val);
          } else if (def.type === 'boolean') {
            conditions.push(`${col} = ?`);
            params.push(val ? 1 : 0);
          } else {
            conditions.push(`${col} = ?`);
            params.push(val);
          }
        }
      }

      // Cursor condition
      if (opts?.cursor) {
        const cursorValues = decodeCursor(opts.cursor);
        const cursorCols = cursorFields.map(f => toSnakeCase(f));

        // Tuple comparison: (col1, col2) > ($cursor1, $cursor2)
        const op = sortDir === 'desc' ? '<' : '>';
        if (cursorCols.length === 1) {
          conditions.push(`${cursorCols[0]} ${op} ?`);
          const f = cursorFields[0];
          const cv = cursorValues[f];
          params.push(
            config.fields[f].type === 'date'
              ? cv instanceof Date
                ? cv.getTime()
                : coerceToDate(cv).getTime()
              : cv,
          );
        } else {
          // Multi-column cursor: (a, b) > (v1, v2) expands to
          // (a > v1) OR (a = v1 AND b > v2)
          const orClauses: string[] = [];
          for (let i = 0; i < cursorCols.length; i++) {
            const parts: string[] = [];
            for (let j = 0; j < i; j++) {
              parts.push(`${cursorCols[j]} = ?`);
              const f = cursorFields[j];
              const cv = cursorValues[f];
              params.push(
                config.fields[f].type === 'date'
                  ? cv instanceof Date
                    ? cv.getTime()
                    : coerceToDate(cv).getTime()
                  : cv,
              );
            }
            parts.push(`${cursorCols[i]} ${op} ?`);
            const f = cursorFields[i];
            const cv = cursorValues[f];
            params.push(
              config.fields[f].type === 'date'
                ? cv instanceof Date
                  ? cv.getTime()
                  : coerceToDate(cv).getTime()
                : cv,
            );
            orClauses.push(`(${parts.join(' AND ')})`);
          }
          conditions.push(`(${orClauses.join(' OR ')})`);
        }
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Sort clause
      const sortColsStr = cursorFields
        .map(f => `${toSnakeCase(f)} ${sortDir === 'desc' ? 'DESC' : 'ASC'}`)
        .join(', ');

      // Fetch limit + 1 to detect hasMore
      params.push(limit + 1);

      const rows = db
        .query<
          Record<string, unknown>
        >(`SELECT * FROM ${table} ${where} ORDER BY ${sortColsStr} LIMIT ?`)
        .all(...params);

      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const items = pageRows.map(row => fromSqliteRow(row, config.fields) as Entity);

      let nextCursor: string | undefined;
      if (hasMore && pageRows.length > 0) {
        const lastRow = fromSqliteRow(pageRows[pageRows.length - 1], config.fields);
        nextCursor = buildCursorForRecord(lastRow, cursorFields);
      }

      return Promise.resolve({ items, nextCursor, hasMore });
    },

    clear() {
      ensureTable();
      db.run(`DELETE FROM ${table}`);
      return Promise.resolve();
    },

    ...(operations ? buildSqliteOperations(operations, config, db, table, ensureTable) : {}),
  };
}
