/**
 * op.consume generator — atomic find + remove (one-time-use tokens).
 */
import { toSnakeCase } from '../../lib/naming';
import type { ResolvedEntityConfig } from '../../types/entity';
import type { ConsumeOpConfig } from '../../types/operations';
import type { Backend } from '../filter';
import {
  compileFilterMemory,
  compileFilterMongo,
  compileFilterPostgres,
  compileFilterSqlite,
  extractParams,
} from '../filter';

/**
 * Generate the consume operation method body for a specific backend.
 *
 * A `consume` operation atomically finds and removes the first matching record
 * (one-time-use token semantics). Optionally checks an expiry field so that
 * expired tokens are not consumed.
 *
 * Backend implementations:
 * - `memory`: iterates the store, deletes the matching entry, and returns the
 *   record (or `true` when `op.returns === 'boolean'`).
 * - `redis`: scans all keys in JS, deletes the matching key via `redis.del()`.
 * - `sqlite`: performs a `SELECT … LIMIT 1` then `DELETE … WHERE pk = ?`
 *   — two statements rather than a single atomic `DELETE … RETURNING` (SQLite
 *   supports RETURNING but the generated code keeps it simple).
 * - `postgres`: uses a single `DELETE … RETURNING *` for true atomicity.
 * - `mongo`: uses `Model.findOneAndDelete()` which is atomic on the document.
 *
 * When `op.expiry` is set the generated code appends an expiry check:
 * `expiry.field IS NULL OR expiry.field > now` — expired tokens return `null`
 * (or `false`) without deleting the record.
 *
 * @param opName - Operation name as declared in the entity config.
 * @param op - The consume operation config (filter, optional expiry, optional
 *   returns override).
 * @param entity - The resolved entity config.
 * @param backend - Target backend.
 * @returns A TypeScript source string for the operation method body.
 *
 * @remarks
 * The generated method returns `Entity | null` by default, or `boolean` when
 * `op.returns === 'boolean'`. The `param:x` pattern in `op.filter` produces
 * named parameters on the generated method.
 */
export function generateConsume(
  opName: string,
  op: ConsumeOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const params = extractParams(op.filter);
  const paramList = params.join(', ');
  const returnsBool = op.returns === 'boolean';

  switch (backend) {
    case 'memory': {
      const predicate = compileFilterMemory(op.filter);
      const expiryCheck = op.expiry
        ? ` && (record['${op.expiry.field}'] == null || record['${op.expiry.field}'] > new Date())`
        : '';

      return `    async ${opName}(${paramList}) {
      for (const [pk, entry] of store) {
        if (!isAlive(entry)) continue;
        const record = entry.record;
        if ((${predicate})${expiryCheck}) {
          store.delete(pk);
          return ${returnsBool ? 'true' : '{ ...record } as Entity'};
        }
      }
      return ${returnsBool ? 'false' : 'null'};
    }`;
    }

    case 'sqlite': {
      const { where, params: sqlParams } = compileFilterSqlite(op.filter, entity);
      const expiryCondition = op.expiry
        ? ` AND (${toSnakeCase(op.expiry.field)} IS NULL OR ${toSnakeCase(op.expiry.field)} > ?)`
        : '';
      const expiryParam = op.expiry ? ', Date.now()' : '';

      return `    async ${opName}(${paramList}) {
      ensureTable();
      const row = db.query(\`SELECT * FROM \${table} WHERE ${where}${expiryCondition} LIMIT 1\`).get(${[...sqlParams, expiryParam ? 'Date.now()' : ''].filter(Boolean).join(', ')});
      if (!row) return ${returnsBool ? 'false' : 'null'};
      db.run(\`DELETE FROM \${table} WHERE ${toSnakeCase(entity._pkField)} = ?\`, [row['${toSnakeCase(entity._pkField)}']]);
      return ${returnsBool ? 'true' : 'fromRow(row) as Entity'};
    }`;
    }

    case 'postgres': {
      const { where, params: pgParams, paramIdx } = compileFilterPostgres(op.filter, entity);
      const expiryCondition = op.expiry
        ? ` AND (${toSnakeCase(op.expiry.field)} IS NULL OR ${toSnakeCase(op.expiry.field)} > $${paramIdx + 1})`
        : '';
      const allParams = op.expiry ? [...pgParams, 'new Date()'] : pgParams;

      return `    async ${opName}(${paramList}) {
      await ensureTable();
      const result = await pool.query(\`DELETE FROM \${table} WHERE ${where}${expiryCondition} RETURNING *\`, [${allParams.join(', ')}]);
      if (result.rows.length === 0) return ${returnsBool ? 'false' : 'null'};
      return ${returnsBool ? 'true' : 'fromRow(result.rows[0]) as Entity'};
    }`;
    }

    case 'mongo': {
      const mongoFilter = compileFilterMongo(op.filter);
      const expiryFilter = op.expiry
        ? `, ${op.expiry.field}: { $or: [null, { $gt: new Date() }] }`
        : '';

      return `    async ${opName}(${paramList}) {
      const Model = getModel();
      const doc = await Model.findOneAndDelete({ ...${mongoFilter}${expiryFilter} }).lean();
      if (!doc) return ${returnsBool ? 'false' : 'null'};
      return ${returnsBool ? 'true' : 'fromMongoDoc(doc) as Entity'};
    }`;
    }

    case 'redis': {
      const predicate = compileFilterMemory(op.filter); // Redis uses in-JS filtering
      const expiryCheck = op.expiry
        ? ` && (record['${op.expiry.field}'] == null || record['${op.expiry.field}'] > new Date())`
        : '';

      return `    async ${opName}(${paramList}) {
      const allKeys = await scanAllKeys();
      for (const key of allKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const record = fromRedisRecord(JSON.parse(raw));
        if ((${predicate})${expiryCheck}) {
          await redis.del(key);
          return ${returnsBool ? 'true' : '{ ...record } as Entity'};
        }
      }
      return ${returnsBool ? 'false' : 'null'};
    }`;
    }
  }
}
