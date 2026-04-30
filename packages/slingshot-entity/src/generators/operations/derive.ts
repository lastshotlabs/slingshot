/**
 * op.derive generator — multi-source read + merge.
 *
 * Reads from multiple sources (potentially different entities),
 * merges results using a specified strategy.
 */
import { toSnakeCase } from '../../lib/naming';
import type { ResolvedEntityConfig } from '../../types/entity';
import type { DeriveOpConfig, DeriveSource } from '../../types/operations';
import type { Backend } from '../filter';

/**
 * Generate the derive operation method body for a specific backend.
 *
 * A `derive` operation reads from multiple named sources, applies an optional
 * `select` projection and optional `traverse` join per source, then merges the
 * results using the configured `op.merge` strategy:
 * - `union`: deduplicates using `Set`.
 * - `concat`: concatenates all source arrays.
 * - `intersect`: keeps only items present in every source.
 * - `first`: returns the first non-empty source result.
 * - `priority`: merges into a `Map` keyed by `JSON.stringify(item)`, later
 *   sources overwriting earlier ones.
 *
 * Backend implementations:
 * - `memory` / `redis`: fully generated — iterates each source's records in JS
 *   using `store.values()` (memory) or `scanAllKeys()` (redis), applies `where`
 *   conditions and optional `traverse` lookups.
 * - `sqlite`: emits one `SELECT` per source with `?`-placeholder WHERE clauses,
 *   then merges all source arrays in JS.
 * - `postgres`: emits one `SELECT` per source with `$N` positional parameters,
 *   then merges in JS.
 * - `mongo`: emits one `Model.find()` per source with a filter object, then
 *   merges in JS. Primary key fields map to `_id`.
 *
 * @param opName - Operation name as declared in the entity config.
 * @param op - The derive operation config (sources array, merge strategy,
 *   optional flatten).
 * @param entity - The resolved entity config.
 * @param backend - Target backend.
 * @returns A TypeScript source string for the operation method body.
 *
 * @remarks
 * Parameters are extracted from all `source.where` values that use the
 * `param:x` pattern. Duplicate parameter names across sources are deduplicated
 * so the generated method has a minimal parameter list.
 */
export function generateDerive(
  opName: string,
  op: DeriveOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  // Collect all params from all sources
  const params: string[] = [];
  for (const source of op.sources) {
    for (const v of Object.values(source.where)) {
      if (typeof v === 'string' && v.startsWith('param:')) {
        params.push(v.slice(6));
      }
    }
  }
  const uniqueParams = [...new Set(params)];
  const paramList = uniqueParams.join(', ');

  const mergeCode = generateMergeCode(op.merge, op.flatten);

  switch (backend) {
    case 'memory':
    case 'redis':
      return generateDeriveInProcess(opName, op, entity, paramList, mergeCode);
    case 'sqlite':
      return generateDeriveSqlite(opName, op, entity, paramList, mergeCode);
    case 'postgres':
      return generateDerivePostgres(opName, op, entity, paramList, mergeCode);
    case 'mongo':
      return generateDeriveMongo(opName, op, entity, paramList, mergeCode);
  }
}

function generateMergeCode(strategy: string, flatten?: boolean): string {
  const flattenStep = flatten ? '\n      merged = merged.flat();' : '';

  switch (strategy) {
    case 'union':
      return `let merged = [...new Set(sourceResults.flat())];${flattenStep}`;
    case 'concat':
      return `let merged = sourceResults.flat();${flattenStep}`;
    case 'intersect':
      return `let merged = sourceResults.reduce((acc, curr) => acc.filter(x => curr.includes(x)));${flattenStep}`;
    case 'first':
      return `let merged = sourceResults.find(r => r.length > 0) ?? [];${flattenStep}`;
    case 'priority':
      return `const mergedMap = new Map();
      for (const results of sourceResults) {
        for (const item of results) {
          const key = JSON.stringify(item);
          mergedMap.set(key, item);
        }
      }
      let merged = [...mergedMap.values()];${flattenStep}`;
    default:
      return `let merged = sourceResults.flat();${flattenStep}`;
  }
}

function generateDeriveInProcess(
  opName: string,
  op: DeriveOpConfig,
  _entity: ResolvedEntityConfig,
  paramList: string,
  mergeCode: string,
): string {
  const sourceBlocks = op.sources.map((source, i) => {
    const whereConds = Object.entries(source.where)
      .map(([field, value]) => {
        if (value === null) return `r['${field}'] == null`;
        if (typeof value === 'string' && value.startsWith('param:'))
          return `r['${field}'] === ${value.slice(6)}`;
        return `r['${field}'] === '${value}'`;
      })
      .join(' && ');

    const selectExpr = source.select ? `r['${source.select}']` : '{ ...r }';

    if (source.traverse) {
      return `    // Source ${i + 1}: ${source.from} → traverse to ${source.traverse.to}
      const source${i} = [];
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        const r = entry.record;
        if (${whereConds}) {
          // Traverse: look up ${source.traverse.to} by ${source.traverse.on}
          const foreignKey = r['${source.traverse.on}'];
          for (const targetEntry of store.values()) {
            if (!isAlive(targetEntry) || !isVisible(targetEntry.record)) continue;
            if (targetEntry.record[pkField] === foreignKey) {
              source${i}.push(targetEntry.record['${source.traverse.select}']);
              break;
            }
          }
        }
      }`;
    }

    return `    // Source ${i + 1}: ${source.from}
      const source${i} = [];
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        const r = entry.record;
        if (${whereConds}) source${i}.push(${selectExpr});
      }`;
  });

  const sourceArrays = op.sources.map((_, i) => `source${i}`);

  return `    async ${opName}(${paramList}) {
${sourceBlocks.join('\n')}
      const sourceResults = [${sourceArrays.join(', ')}];
      ${mergeCode}
      return merged;
    }`;
}

// ---------------------------------------------------------------------------
// Helpers for SQL/Mongo source query generation
// ---------------------------------------------------------------------------

function sqliteWhereClause(source: DeriveSource): { where: string; binds: string[] } {
  const conditions: string[] = [];
  const binds: string[] = [];
  for (const [field, value] of Object.entries(source.where)) {
    const col = toSnakeCase(field);
    if (value === null) {
      conditions.push(`${col} IS NULL`);
    } else if (value.startsWith('param:')) {
      conditions.push(`${col} = ?`);
      binds.push(value.slice(6));
    } else {
      conditions.push(`${col} = '${value.replace(/'/g, "''")}'`);
    }
  }
  return { where: conditions.join(' AND '), binds };
}

function postgresWhereClause(
  source: DeriveSource,
  startIdx: number,
): { where: string; binds: string[]; nextIdx: number } {
  const conditions: string[] = [];
  const binds: string[] = [];
  let idx = startIdx;
  for (const [field, value] of Object.entries(source.where)) {
    const col = toSnakeCase(field);
    if (value === null) {
      conditions.push(`${col} IS NULL`);
    } else if (value.startsWith('param:')) {
      idx++;
      conditions.push(`${col} = $${idx}`);
      binds.push(value.slice(6));
    } else {
      conditions.push(`${col} = '${value.replace(/'/g, "''")}'`);
    }
  }
  return { where: conditions.join(' AND '), binds, nextIdx: idx };
}

function mongoQueryObject(source: DeriveSource, entity: ResolvedEntityConfig): string {
  const parts = Object.entries(source.where).map(([field, value]) => {
    const mongoField = entity.fields[field]?.primary ? '_id' : field;
    if (value === null) return `${mongoField}: null`;
    if (value.startsWith('param:')) return `${mongoField}: ${value.slice(6)}`;
    return `${mongoField}: '${value}'`;
  });
  return `{ ${parts.join(', ')} }`;
}

// ---------------------------------------------------------------------------
// SQLite derive
// ---------------------------------------------------------------------------

function generateDeriveSqlite(
  opName: string,
  op: DeriveOpConfig,
  _entity: ResolvedEntityConfig,
  paramList: string,
  mergeCode: string,
): string {
  const sourceArrays = op.sources.map((_, i) => `source${i}`);

  const sourceBlocks = op.sources.map((source, i) => {
    const { where, binds } = sqliteWhereClause(source);
    const selectCol = source.select ? toSnakeCase(source.select) : '*';
    const queryStr = `SELECT ${selectCol} FROM ${source.from} WHERE ${where}`;
    const bindList = binds.length > 0 ? binds.join(', ') : '';

    if (source.traverse) {
      const tCol = toSnakeCase(source.traverse.on);
      const tSelectCol = toSnakeCase(source.traverse.select);
      return `      // Source ${i + 1}: ${source.from} -> traverse to ${source.traverse.to}
      const _srcRows${i} = db.query(\`${queryStr}\`).all(${bindList});
      const source${i} = [];
      for (const _sr of _srcRows${i}) {
        const _fk = _sr['${tCol}'];
        const _tr = db.query(\`SELECT ${tSelectCol} FROM ${source.traverse.to} WHERE ${toSnakeCase(source.traverse.to.replace(/s$/, '_id'))} = ?\`).get(_fk);
        if (_tr) source${i}.push(_tr['${tSelectCol}']);
      }`;
    }

    if (source.select) {
      return `      // Source ${i + 1}: ${source.from}
      const source${i} = db.query(\`${queryStr}\`).all(${bindList}).map(r => r['${toSnakeCase(source.select)}']);`;
    }

    return `      // Source ${i + 1}: ${source.from}
      const source${i} = db.query(\`${queryStr}\`).all(${bindList}).map(r => fromRow(r));`;
  });

  return `    async ${opName}(${paramList}) {
      ensureTable();
${sourceBlocks.join('\n')}
      const sourceResults = [${sourceArrays.join(', ')}];
      ${mergeCode}
      return merged;
    }`;
}

// ---------------------------------------------------------------------------
// Postgres derive
// ---------------------------------------------------------------------------

function generateDerivePostgres(
  opName: string,
  op: DeriveOpConfig,
  _entity: ResolvedEntityConfig,
  paramList: string,
  mergeCode: string,
): string {
  const sourceArrays = op.sources.map((_, i) => `source${i}`);

  const sourceBlocks = op.sources.map((source, i) => {
    const { where, binds } = postgresWhereClause(source, 0);
    const selectCol = source.select ? toSnakeCase(source.select) : '*';
    const queryStr = `SELECT ${selectCol} FROM ${source.from} WHERE ${where}`;
    const bindList = binds.length > 0 ? `[${binds.join(', ')}]` : '[]';

    if (source.traverse) {
      const tCol = toSnakeCase(source.traverse.on);
      const tSelectCol = toSnakeCase(source.traverse.select);
      return `      // Source ${i + 1}: ${source.from} -> traverse to ${source.traverse.to}
      const _srcResult${i} = await pool.query(\`${queryStr}\`, ${bindList});
      const source${i} = [];
      for (const _sr of _srcResult${i}.rows) {
        const _fk = _sr['${tCol}'];
        const _tr = await pool.query(\`SELECT ${tSelectCol} FROM ${source.traverse.to} WHERE id = $1\`, [_fk]);
        if (_tr.rows[0]) source${i}.push(_tr.rows[0]['${tSelectCol}']);
      }`;
    }

    if (source.select) {
      return `      // Source ${i + 1}: ${source.from}
      const _r${i} = await pool.query(\`${queryStr}\`, ${bindList});
      const source${i} = _r${i}.rows.map(r => r['${toSnakeCase(source.select)}']);`;
    }

    return `      // Source ${i + 1}: ${source.from}
      const _r${i} = await pool.query(\`${queryStr}\`, ${bindList});
      const source${i} = _r${i}.rows.map(r => fromRow(r));`;
  });

  return `    async ${opName}(${paramList}) {
      await ensureTable();
${sourceBlocks.join('\n')}
      const sourceResults = [${sourceArrays.join(', ')}];
      ${mergeCode}
      return merged;
    }`;
}

// ---------------------------------------------------------------------------
// Mongo derive
// ---------------------------------------------------------------------------

function generateDeriveMongo(
  opName: string,
  op: DeriveOpConfig,
  entity: ResolvedEntityConfig,
  paramList: string,
  mergeCode: string,
): string {
  const sourceArrays = op.sources.map((_, i) => `source${i}`);

  const sourceBlocks = op.sources.map((source, i) => {
    const query = mongoQueryObject(source, entity);

    if (source.traverse) {
      return `      // Source ${i + 1}: ${source.from} -> traverse to ${source.traverse.to}
      const _srcDocs${i} = await getModel().find(${query}).lean();
      const source${i} = [];
      for (const _sd of _srcDocs${i}) {
        const _fk = _sd['${source.traverse.on}'];
        const _td = await getModel().findOne({ _id: _fk }).lean();
        if (_td) source${i}.push(_td['${source.traverse.select}']);
      }`;
    }

    if (source.select) {
      return `      // Source ${i + 1}: ${source.from}
      const _docs${i} = await getModel().find(${query}).lean();
      const source${i} = _docs${i}.map(d => d['${source.select}']);`;
    }

    return `      // Source ${i + 1}: ${source.from}
      const _docs${i} = await getModel().find(${query}).lean();
      const source${i} = _docs${i}.map(d => fromMongoDoc(d));`;
  });

  return `    async ${opName}(${paramList}) {
      const Model = getModel();
${sourceBlocks.join('\n')}
      const sourceResults = [${sourceArrays.join(', ')}];
      ${mergeCode}
      return merged;
    }`;
}
