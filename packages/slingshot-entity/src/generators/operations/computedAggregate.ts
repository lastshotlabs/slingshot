/**
 * op.computedAggregate generator â€” aggregate + write result to parent.
 *
 * Generates backend-specific adapter methods that read matching source records,
 * compute aggregate values, and materialize the result onto a target record.
 */
import { toSnakeCase } from '../../lib/naming';
import type { ResolvedEntityConfig } from '../../types/entity';
import type { ComputedAggregateOpConfig, ComputedField } from '../../types/operations';
import type { Backend } from '../filter';
import { compileFilterMemory, extractMatchParams, extractParams } from '../filter';

/**
 * Build per-field compute statements for a `computedAggregate` operation.
 *
 * Supported specs:
 * - `'count'`
 * - `{ count: true }`
 * - `{ countBy: 'field' }`
 * - `{ sum: 'field' }`
 * - optional `where` filters on the object form
 */
function buildComputeStatements(op: ComputedAggregateOpConfig): string[] {
  return Object.entries(op.compute).map(([name, spec]) => {
    if (spec === 'count') return `result['${name}'] = sourceRecords.length;`;

    if (typeof spec === 'object') {
      const typed: ComputedField = spec;
      const filtered = typed.where
        ? `.filter(r => ${Object.entries(typed.where)
            .map(([f, v]) => {
              if (v === null) return `r['${f}'] === null`;
              if (typeof v === 'string') return `r['${f}'] === '${v}'`;
              if (typeof v === 'number' || typeof v === 'boolean')
                return `r['${f}'] === ${String(v)}`;
              return `r['${f}'] === null`;
            })
            .join(' && ')})`
        : '';

      if (typed.count) {
        return `result['${name}'] = sourceRecords${filtered}.length;`;
      }
      if (typed.countBy) {
        return `result['${name}'] = sourceRecords${filtered}.reduce((acc, r) => { const k = String(r['${typed.countBy}']); acc[k] = (acc[k] || 0) + 1; return acc; }, {});`;
      }
      if (typed.sum) {
        return `result['${name}'] = sourceRecords${filtered}.reduce((sum, r) => sum + (Number(r['${typed.sum}']) || 0), 0);`;
      }
    }

    return `result['${name}'] = 0;`;
  });
}

function buildTargetResolution(op: ComputedAggregateOpConfig): string {
  return Object.entries(op.targetMatch)
    .map(([field, value]) => {
      const rhs = value.startsWith('param:')
        ? `params['${value.slice(6)}']`
        : JSON.stringify(value);
      return `targetResolved['${field}'] = ${rhs};`;
    })
    .join('\n      ');
}

/**
 * Generate the computedAggregate operation method body for a specific backend.
 */
export function generateComputedAggregate(
  opName: string,
  op: ComputedAggregateOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const sourceParams = extractParams(op.sourceFilter);
  const targetParams = extractMatchParams(op.targetMatch);
  const allParams = [...new Set([...sourceParams, ...targetParams])];
  const paramList = allParams.join(', ');

  switch (backend) {
    case 'memory':
    case 'redis':
      return generateComputedAggInProcess(opName, op, backend, paramList);
    case 'sqlite':
      return generateComputedAggSqlite(opName, op, paramList);
    case 'postgres':
      return generateComputedAggPostgres(opName, op, paramList);
    case 'mongo':
      return generateComputedAggMongo(opName, op, paramList);
  }
}

function generateComputedAggInProcess(
  opName: string,
  op: ComputedAggregateOpConfig,
  backend: 'memory' | 'redis',
  paramList: string,
): string {
  const predicate = compileFilterMemory(op.sourceFilter);
  const computeStatements = buildComputeStatements(op);
  const targetMatch = buildTargetResolution(op);
  const sourceSetup =
    backend === 'memory'
      ? `const sourceRecords = [];
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        const record = entry.record;
        if (${predicate}) sourceRecords.push(record);
      }`
      : `const allKeys = await scanAllKeys();
      const sourceRecords = [];
      for (const key of allKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const record = fromRedisRecord(JSON.parse(raw));
        if (!isVisible(record)) continue;
        if (${predicate}) sourceRecords.push(record);
      }`;
  const targetSetup =
    backend === 'memory'
      ? `for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        const r = entry.record;
        let matches = true;
        for (const [field, target] of Object.entries(targetResolved)) {
          if (r[field] !== target) {
            matches = false;
            break;
          }
        }
        if (matches) {
          r['${op.materializeTo}'] = result;
          break;
        }
      }`
      : `for (const key of allKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const r = fromRedisRecord(JSON.parse(raw));
        if (!isVisible(r)) continue;
        let matches = true;
        for (const [field, target] of Object.entries(targetResolved)) {
          if (r[field] !== target) {
            matches = false;
            break;
          }
        }
        if (matches) {
          r['${op.materializeTo}'] = result;
          await storeRecord(r);
          break;
        }
      }`;

  return `    async ${opName}(${paramList}) {
      ${sourceSetup}
      const result = {};
      ${computeStatements.join('\n      ')}
      const targetResolved = {};
      ${targetMatch}
      ${targetSetup}
    }`;
}

function generateComputedAggSqlite(
  opName: string,
  op: ComputedAggregateOpConfig,
  paramList: string,
): string {
  const predicate = compileFilterMemory(op.sourceFilter);
  const computeStatements = buildComputeStatements(op);
  const targetMatch = buildTargetResolution(op);

  return `    async ${opName}(${paramList}) {
      ensureTable();
      const rows = db.query(\`SELECT * FROM \${table}\`).all();
      const sourceRecords = [];
      for (const row of rows) {
        const record = row;
        if (${predicate}) sourceRecords.push(record);
      }
      const result = {};
      ${computeStatements.join('\n      ')}
      const targetResolved = {};
      ${targetMatch}
      const conditions = [];
      const values: unknown[] = [];
      for (const [field, target] of Object.entries(targetResolved)) {
        conditions.push(\`\${toSnakeCase(field)} = ?\`);
        values.push(target);
      }
      db.run(
        \`UPDATE \${table} SET ${toSnakeCase(op.materializeTo)} = ? WHERE \${conditions.join(' AND ')}\`,
        [JSON.stringify(result), ...values],
      );
    }`;
}

function generateComputedAggPostgres(
  opName: string,
  op: ComputedAggregateOpConfig,
  paramList: string,
): string {
  const predicate = compileFilterMemory(op.sourceFilter);
  const computeStatements = buildComputeStatements(op);
  const targetMatch = buildTargetResolution(op);

  return `    async ${opName}(${paramList}) {
      await ensureTable();
      const resultSet = await pool.query(\`SELECT * FROM \${table}\`, []);
      const sourceRecords = [];
      for (const row of resultSet.rows) {
        const record = row;
        if (${predicate}) sourceRecords.push(record);
      }
      const result = {};
      ${computeStatements.join('\n      ')}
      const targetResolved = {};
      ${targetMatch}
      const conditions = [];
      const values: unknown[] = [JSON.stringify(result)];
      let pIdx = 1;
      for (const [field, target] of Object.entries(targetResolved)) {
        conditions.push(\`\${toSnakeCase(field)} = $\${++pIdx}\`);
        values.push(target);
      }
      await pool.query(
        \`UPDATE \${table} SET ${toSnakeCase(op.materializeTo)} = $1 WHERE \${conditions.join(' AND ')}\`,
        values,
      );
    }`;
}

function generateComputedAggMongo(
  opName: string,
  op: ComputedAggregateOpConfig,
  paramList: string,
): string {
  const predicate = compileFilterMemory(op.sourceFilter);
  const computeStatements = buildComputeStatements(op);
  const targetMatch = buildTargetResolution(op);

  return `    async ${opName}(${paramList}) {
      const Model = getModel();
      const rows = await Model.find({}).lean();
      const sourceRecords = [];
      for (const row of rows) {
        const record = row;
        if (${predicate}) sourceRecords.push(record);
      }
      const result = {};
      ${computeStatements.join('\n      ')}
      const targetResolved = {};
      ${targetMatch}
      await Model.updateOne(targetResolved, { $set: { ${op.materializeTo}: result } });
    }`;
}
