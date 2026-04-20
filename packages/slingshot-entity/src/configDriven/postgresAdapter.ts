/**
 * Config-driven PostgreSQL adapter generator.
 *
 * Produces a full `EntityAdapter` implementation backed by a `pg` connection pool,
 * driven entirely by `ResolvedEntityConfig` — no hand-written SQL schema required.
 *
 * **Features:**
 * - Auto-creates the table on first use (`CREATE TABLE IF NOT EXISTS`) with correct
 *   column types, `NOT NULL` constraints, and a `PRIMARY KEY`.
 * - Creates compound indexes (`CREATE INDEX IF NOT EXISTS`) and unique constraints
 *   (`CREATE UNIQUE INDEX IF NOT EXISTS`) from `config.indexes` and `config.uniques`.
 * - Optional `_expires_at BIGINT` column when `config.ttl.defaultSeconds` is set.
 * - Soft-delete: `delete()` writes the soft-delete field value instead of `DELETE`.
 * - Cursor pagination: multi-field lexicographic cursors via `buildCursorForRecord`/`decodeCursor`.
 * - `create()` uses `INSERT ... ON CONFLICT DO UPDATE` (upsert semantics) to handle idempotent creates.
 * - Spreads `buildPostgresOperations()` result to attach custom operation methods.
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
  fromPgRow,
  pgColumnType,
  storageName,
  toPgRow,
  toSnakeCase,
} from './fieldUtils';
import { resolveListFilter } from './listFilter';
import { withOptionalPostgresTransaction } from './operationExecutors/postgresTransaction';
import { buildPostgresOperations } from './postgresOperationWiring';

/**
 * Minimal `pg` Pool interface required by this adapter.
 *
 * Defined locally so the adapter does not import `pg` directly — callers pass
 * a compatible pool and TypeScript structural typing enforces the contract.
 * The real `pg.Pool` satisfies this interface.
 */
interface PgPool {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  connect?(): Promise<{
    query(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
    release?(): void;
  }>;
}

/**
 * Create a config-driven Postgres entity adapter.
 *
 * The adapter is fully lazy — table creation is deferred to the first query via
 * `ensureTable()`, which is idempotent and runs at most once per adapter instance
 * (guarded by the `initialized` flag in closure).
 *
 * Generic type parameters let callers get back properly-typed records and inputs:
 * - `Entity` — the full entity type returned by `getById`, `create`, `update`, `list`.
 * - `CreateInput` — the input accepted by `create`.
 * - `UpdateInput` — the partial input accepted by `update`.
 *
 * @param pool       - A `pg`-compatible connection pool.
 * @param config     - Resolved entity config driving table shape, TTL, soft-delete, pagination.
 * @param operations - Optional map of operation configs (from `defineOperations()`); when
 *                     provided, operation methods are spread onto the returned adapter object.
 * @returns An `EntityAdapter` extended with any operation methods derived from `operations`.
 *
 * @example
 * ```ts
 * const adapter = createPostgresEntityAdapter<User, CreateUser, UpdateUser>(
 *   pool, User, UserOps.operations,
 * );
 * const user = await adapter.create({ name: 'Alice' });
 * const results = await adapter.byEmail({ email: 'alice@example.com' });
 * ```
 */
export function createPostgresEntityAdapter<Entity, CreateInput, UpdateInput>(
  pool: PgPool,
  config: ResolvedEntityConfig,
  operations?: Record<string, OperationConfig>,
): EntityAdapter<Entity, CreateInput, UpdateInput> & Record<string, unknown> {
  const table = storageName(config, 'postgres');
  const pkField = config._pkField;
  const pkColumn = toSnakeCase(pkField);
  const ttlSeconds = config.ttl?.defaultSeconds;
  let initialized = false;
  let initializationPromise: Promise<void> | null = null;

  const defaultLimit = config.pagination?.defaultLimit ?? 50;
  const maxLimit = config.pagination?.maxLimit ?? 200;
  const cursorFields = config.pagination?.cursor.fields ?? [pkField];
  const defaultSortDir = config.defaultSort?.direction ?? 'asc';

  /**
   * Idempotent table initializer — runs once per adapter instance.
   *
   * Creates the table with correct column types, a primary key, and `NOT NULL`
   * constraints. Adds an `_expires_at BIGINT NOT NULL` column when TTL is configured.
   * Then creates compound indexes and unique constraints from `config.indexes` and
   * `config.uniques`. All DDL statements use `IF NOT EXISTS` to be safe to replay.
   *
   * Sets `initialized = true` on success so subsequent calls return immediately.
   */
  async function ensureTable(): Promise<void> {
    if (initialized) return;
    if (initializationPromise) {
      await initializationPromise;
      return;
    }

    initializationPromise = (async () => {
      await withOptionalPostgresTransaction(pool, async queryable => {
        const cols: string[] = [];
        for (const [name, def] of Object.entries(config.fields)) {
          const col = toSnakeCase(name);
          const pgType = pgColumnType(def.type);
          const notNull = !def.optional && !def.primary ? ' NOT NULL' : '';
          const pk = def.primary ? ' PRIMARY KEY NOT NULL' : '';
          cols.push(`${col} ${pgType}${pk}${notNull}`);
        }

        if (ttlSeconds) {
          cols.push('_expires_at BIGINT NOT NULL');
        }

        await queryable.query(`CREATE TABLE IF NOT EXISTS ${table} (\n  ${cols.join(',\n  ')}\n)`);

        // Compound indexes
        if (config.indexes) {
          for (let i = 0; i < config.indexes.length; i++) {
            const idx = config.indexes[i];
            const colList = idx.fields.map(f => toSnakeCase(f)).join(', ');
            const unique = idx.unique ? 'UNIQUE ' : '';
            await queryable.query(
              `CREATE ${unique}INDEX IF NOT EXISTS idx_${table}_${i} ON ${table} (${colList})`,
            );
          }
        }

        // Unique constraints
        if (config.uniques) {
          for (let i = 0; i < config.uniques.length; i++) {
            const uq = config.uniques[i];
            const colList = uq.fields.map(f => toSnakeCase(f)).join(', ');
            await queryable.query(
              `CREATE UNIQUE INDEX IF NOT EXISTS uidx_${table}_${i} ON ${table} (${colList})`,
            );
          }
        }
      });

      initialized = true;
    })();

    try {
      await initializationPromise;
    } finally {
      initializationPromise = null;
    }
  }

  /**
   * Compute the absolute expiry timestamp (milliseconds since epoch) for a new record.
   *
   * Only called when `config.ttl.defaultSeconds` is set. The returned value is stored
   * in the `_expires_at` column and compared against `Date.now()` in read queries to
   * exclude expired records without a background cleanup job.
   *
   * @returns Current timestamp plus the configured TTL, in milliseconds.
   */
  function expiresAt(): number {
    return Date.now() + (ttlSeconds ?? 0) * 1000;
  }

  function appendFilterConditions(
    filter: Record<string, unknown> | undefined,
    conditions: string[],
    params: unknown[],
    paramIdxRef: { value: number },
  ): void {
    if (!filter) return;

    for (const [key, val] of Object.entries(filter)) {
      if (val === undefined) continue;
      if (key === 'limit' || key === 'cursor' || key === 'sortDir') continue;
      if (!(key in config.fields)) continue;

      const col = toSnakeCase(key);
      const def = config.fields[key];
      if (def.type === 'json') {
        conditions.push(`${col} = $${paramIdxRef.value++}`);
        params.push(JSON.stringify(val));
      } else if (def.type === 'date') {
        conditions.push(`${col} = $${paramIdxRef.value++}`);
        params.push(val instanceof Date ? val : coerceToDate(val));
      } else {
        conditions.push(`${col} = $${paramIdxRef.value++}`);
        params.push(val);
      }
    }
  }

  function buildWhereClause(
    id: string | number,
    filter: Record<string, unknown> | undefined,
    startParamIdx: number,
  ): { where: string; params: unknown[] } {
    const conditions: string[] = [`${pkColumn} = $${startParamIdx}`];
    const params: unknown[] = [id];
    const paramIdxRef = { value: startParamIdx + 1 };
    appendFilterConditions(filter, conditions, params, paramIdxRef);

    if (config.softDelete) {
      if ('value' in config.softDelete) {
        conditions.push(`${toSnakeCase(config.softDelete.field)} != $${paramIdxRef.value}`);
        params.push(config.softDelete.value);
        paramIdxRef.value++;
      } else {
        conditions.push(`${toSnakeCase(config.softDelete.field)} IS NULL`);
      }
    }
    if (ttlSeconds) {
      conditions.push(`_expires_at > $${paramIdxRef.value}`);
      params.push(Date.now());
      paramIdxRef.value++;
    }

    return { where: conditions.join(' AND '), params };
  }

  return {
    async create(input) {
      await ensureTable();

      const record = applyDefaults(input as Record<string, unknown>, config.fields);
      const row = toPgRow(record, config.fields);
      if (ttlSeconds) row['_expires_at'] = expiresAt();

      const columns = Object.keys(row);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const values = columns.map(c => row[c]);

      // UPSERT
      const nonPkCols = columns.filter(c => c !== pkColumn);
      const onConflict =
        nonPkCols.length > 0
          ? `ON CONFLICT (${pkColumn}) DO UPDATE SET ${nonPkCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`
          : `ON CONFLICT (${pkColumn}) DO NOTHING`;

      await pool.query(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ${onConflict}`,
        values,
      );

      return { ...record } as unknown as Entity;
    },

    async getById(id, filter) {
      await ensureTable();
      const { where, params } = buildWhereClause(id, filter, 1);
      const result = await pool.query(`SELECT * FROM ${table} WHERE ${where} LIMIT 1`, params);

      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      return fromPgRow(row, config.fields) as Entity;
    },

    async update(id, input, filter) {
      await ensureTable();

      const updatePayload = applyOnUpdate(input as Record<string, unknown>, config.fields);
      const partial = toPgRow(updatePayload, config.fields);
      if (ttlSeconds) partial['_expires_at'] = expiresAt();

      const entries = Object.entries(partial);
      if (entries.length === 0) {
        const { where, params } = buildWhereClause(id, filter, 1);
        const current = await pool.query(`SELECT * FROM ${table} WHERE ${where} LIMIT 1`, params);
        const currentRow = current.rows[0] as Record<string, unknown> | undefined;
        if (!currentRow) return null;
        return fromPgRow(currentRow, config.fields) as Entity;
      }

      let paramIdx = 1;
      const setClauses = entries.map(([col]) => `${col} = $${paramIdx++}`).join(', ');
      const values: unknown[] = entries.map(([, v]) => v);
      const { where, params } = buildWhereClause(id, filter, entries.length + 1);
      values.push(...params);

      const result = await pool.query(`UPDATE ${table} SET ${setClauses} WHERE ${where}`, values);

      if ((result.rowCount ?? 0) === 0) {
        return null;
      }

      // Read back the updated record
      const readback = buildWhereClause(id, filter, 1);
      const updated = await pool.query(
        `SELECT * FROM ${table} WHERE ${readback.where} LIMIT 1`,
        readback.params,
      );
      const updatedRow = updated.rows[0] as Record<string, unknown> | undefined;
      if (!updatedRow) return null;
      return fromPgRow(updatedRow, config.fields) as Entity;
    },

    async delete(id, filter) {
      await ensureTable();

      if (config.softDelete) {
        const onUpdatePayload = applyOnUpdate({}, config.fields);
        const partial = toPgRow(onUpdatePayload, config.fields);
        partial[toSnakeCase(config.softDelete.field)] =
          'value' in config.softDelete ? config.softDelete.value : new Date().toISOString();

        const entries = Object.entries(partial);
        let paramIdx = 1;
        const setClauses = entries.map(([col]) => `${col} = $${paramIdx++}`).join(', ');
        const values: unknown[] = entries.map(([, v]) => v);
        const { where, params } = buildWhereClause(id, filter, entries.length + 1);
        values.push(...params);
        const result = await pool.query(`UPDATE ${table} SET ${setClauses} WHERE ${where}`, values);
        return (result.rowCount ?? 0) > 0;
      } else {
        const { where, params } = buildWhereClause(id, filter, 1);
        const result = await pool.query(`DELETE FROM ${table} WHERE ${where}`, params);
        return (result.rowCount ?? 0) > 0;
      }
    },

    async list(opts) {
      await ensureTable();

      const sortDir = opts?.sortDir ?? defaultSortDir;
      const rawLimit = opts?.limit ?? defaultLimit;
      const limit = Math.min(rawLimit, maxLimit);
      const filter = resolveListFilter(opts as Record<string, unknown> | undefined);

      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      // Soft-delete
      if (config.softDelete) {
        if ('value' in config.softDelete) {
          conditions.push(`${toSnakeCase(config.softDelete.field)} != $${paramIdx++}`);
          params.push(config.softDelete.value);
        } else {
          conditions.push(`${toSnakeCase(config.softDelete.field)} IS NULL`);
        }
      }

      // TTL
      if (ttlSeconds) {
        conditions.push(`_expires_at > $${paramIdx++}`);
        params.push(Date.now());
      }

      // Filter
      if (filter) {
        for (const [key, val] of Object.entries(filter)) {
          if (val === undefined) continue;
          if (!(key in config.fields)) continue;

          const col = toSnakeCase(key);
          const def = config.fields[key];

          if (def.type === 'json') {
            conditions.push(`${col} = $${paramIdx++}`);
            params.push(JSON.stringify(val));
          } else if (def.type === 'date') {
            conditions.push(`${col} = $${paramIdx++}`);
            params.push(val instanceof Date ? val : coerceToDate(val));
          } else {
            conditions.push(`${col} = $${paramIdx++}`);
            params.push(val);
          }
        }
      }

      // Cursor
      if (opts?.cursor) {
        const cursorValues = decodeCursor(opts.cursor);
        const op = sortDir === 'desc' ? '<' : '>';

        if (cursorFields.length === 1) {
          const f = cursorFields[0];
          const col = toSnakeCase(f);
          let cv = cursorValues[f];
          if (config.fields[f].type === 'date' && typeof cv === 'string') cv = new Date(cv);
          conditions.push(`${col} ${op} $${paramIdx++}`);
          params.push(cv);
        } else {
          // Multi-field cursor
          const orClauses: string[] = [];
          for (let i = 0; i < cursorFields.length; i++) {
            const parts: string[] = [];
            for (let j = 0; j < i; j++) {
              const f = cursorFields[j];
              const col = toSnakeCase(f);
              let cv = cursorValues[f];
              if (config.fields[f].type === 'date' && typeof cv === 'string') cv = new Date(cv);
              parts.push(`${col} = $${paramIdx++}`);
              params.push(cv);
            }
            const f = cursorFields[i];
            const col = toSnakeCase(f);
            let cv = cursorValues[f];
            if (config.fields[f].type === 'date' && typeof cv === 'string') cv = new Date(cv);
            parts.push(`${col} ${op} $${paramIdx++}`);
            params.push(cv);
            orClauses.push(`(${parts.join(' AND ')})`);
          }
          conditions.push(`(${orClauses.join(' OR ')})`);
        }
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Sort
      const sortColsStr = cursorFields
        .map(f => `${toSnakeCase(f)} ${sortDir === 'desc' ? 'DESC' : 'ASC'}`)
        .join(', ');

      params.push(limit + 1);

      const result = await pool.query(
        `SELECT * FROM ${table} ${where} ORDER BY ${sortColsStr} LIMIT $${paramIdx}`,
        params,
      );

      const hasMore = result.rows.length > limit;
      const pageRows = result.rows.slice(0, limit);
      const items = pageRows.map(row => fromPgRow(row, config.fields) as Entity);

      let nextCursor: string | undefined;
      if (hasMore && pageRows.length > 0) {
        const lastRow = fromPgRow(pageRows[pageRows.length - 1], config.fields);
        nextCursor = buildCursorForRecord(lastRow, cursorFields);
      }

      return { items, nextCursor, hasMore };
    },

    async clear() {
      await ensureTable();
      await pool.query(`DELETE FROM ${table}`);
    },

    ...(operations ? buildPostgresOperations(operations, config, pool, table, ensureTable) : {}),
  };
}
