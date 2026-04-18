/**
 * op.aggregate generator — group + compute (count/sum/avg/min/max).
 */
import type { ResolvedEntityConfig } from '../../types/entity';
import type { FilterValue } from '../../types/filter';
import type { AggregateOpConfig, ComputedField, GroupByConfig } from '../../types/operations';
import type { Backend } from '../filter';
import { compileFilterMemory, extractParams } from '../filter';

function isComputedField(v: unknown): v is ComputedField {
  return typeof v === 'object' && v !== null && ('count' in v || 'countBy' in v || 'sum' in v);
}

/** Get the field name from a string or object groupBy. */
function getGroupByField(groupBy: string | GroupByConfig): string {
  return typeof groupBy === 'string' ? groupBy : groupBy.field;
}

/**
 * Return the generated helper declaration and key expression for groupBy.
 *
 * For plain string groupBy, the key is `r['field']` with no helper needed.
 * For object groupBy with `truncate`, emits a `__groupKey` helper that
 * truncates date values and returns `__groupKey(r['field'])`.
 */
function groupKeyParts(groupBy: string | GroupByConfig): { helper: string; expr: string } {
  if (typeof groupBy === 'string') {
    return { helper: '', expr: `r['${groupBy}']` };
  }
  const field = groupBy.field;
  if (!groupBy.truncate) {
    return { helper: '', expr: `r['${field}']` };
  }
  const truncate = groupBy.truncate;
  let body: string;
  if (truncate === 'week') {
    body =
      `if (v == null) return v; ` +
      `const d = v instanceof Date ? v : new Date(String(v)); ` +
      `if (isNaN(d.getTime())) return String(v); ` +
      `d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); ` +
      `return d.toISOString().slice(0, 10);`;
  } else {
    const len = { year: 4, month: 7, day: 10, hour: 13 }[truncate];
    body =
      `if (v == null) return v; ` +
      `const d = v instanceof Date ? v : new Date(String(v)); ` +
      `if (isNaN(d.getTime())) return String(v); ` +
      `return d.toISOString().slice(0, ${len});`;
  }
  return {
    helper: `const __groupKey = (v) => { ${body} };`,
    expr: `__groupKey(r['${field}'])`,
  };
}

function filterValueToCode(v: FilterValue): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return `'${v}'`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return 'null';
}

/**
 * Generate the aggregate operation method body for a specific backend.
 *
 * Produces a `async {opName}(params)` method body that computes aggregate
 * values (count, sum, avg, min, max, groupBy, countBy) over a filtered set of
 * records. The generated code is embedded inside the backend adapter factory's
 * return object.
 *
 * Backend implementations:
 * - `memory` / `redis`: in-process iteration over the store/SCAN results, JS
 *   reduce/filter for each compute function.
 * - `sqlite`: single SQL `SELECT … FROM table WHERE … GROUP BY …` query using
 *   `COUNT(*)`, `SUM()`, `AVG()`, `MIN()`, `MAX()`.
 * - `postgres`: same as SQLite but using `COALESCE()` and `::int` / `::numeric`
 *   casts for null safety.
 * - `mongo`: MongoDB aggregation pipeline with `$match`, `$group`, and mapped
 *   `$sum`, `$avg`, `$min`, `$max` accumulators.
 *
 * @param opName - Operation name as declared in the entity config.
 * @param op - The aggregate operation config (compute map, optional filter and
 *   groupBy).
 * @param entity - The resolved entity config.
 * @param backend - Target backend.
 * @returns A TypeScript source string for the operation method body.
 */
export function generateAggregate(
  opName: string,
  op: AggregateOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const params = op.filter ? extractParams(op.filter) : [];
  const paramList = params.join(', ');

  switch (backend) {
    case 'memory':
    case 'redis':
      return generateAggregateInProcess(opName, op, entity, backend, paramList);
    case 'sqlite':
      return generateAggregateSqlite(opName, op, entity, paramList);
    case 'postgres':
      return generateAggregatePostgres(opName, op, entity, paramList);
    case 'mongo':
      return generateAggregateMongo(opName, op, entity, paramList);
  }
}

function generateAggregateInProcess(
  opName: string,
  op: AggregateOpConfig,
  _entity: ResolvedEntityConfig,
  backend: 'memory' | 'redis',
  paramList: string,
): string {
  const filterPredicate = op.filter ? compileFilterMemory(op.filter) : 'true';
  const iteratorSetup =
    backend === 'memory'
      ? `const records = [];
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        const record = entry.record;
        if (${filterPredicate}) records.push(record);
      }`
      : `const allKeys = await scanAllKeys();
      const records = [];
      for (const key of allKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const record = fromRedisRecord(JSON.parse(raw));
        if (!isVisible(record)) continue;
        if (${filterPredicate}) records.push(record);
      }`;

  if (op.groupBy) {
    const field = getGroupByField(op.groupBy);
    const { helper, expr } = groupKeyParts(op.groupBy);
    const computeReducer = generateMemoryComputeReduce(op.compute);
    return `    async ${opName}(${paramList}) {
      ${iteratorSetup}
      ${helper}
      const groups = new Map();
      for (const r of records) {
        const key = ${expr};
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      const results = [];
      for (const [key, items] of groups) {
        results.push({ '${field}': key, ${computeReducer} });
      }
      return results;
    }`;
  }

  const computeResult = generateMemoryComputeSingle(op.compute);
  return `    async ${opName}(${paramList}) {
      ${iteratorSetup}
      return { ${computeResult} };
    }`;
}

function generateMemoryComputeReduce(compute: Record<string, unknown>): string {
  return Object.entries(compute)
    .map(([name, spec]) => {
      if (spec === 'count') return `${name}: items.length`;
      if (typeof spec === 'string')
        return `${name}: items.reduce((s, r) => s + (Number(r['${name}']) || 0), 0)`;
      if (isComputedField(spec)) {
        if (spec.count && spec.where) {
          const conds = Object.entries(spec.where)
            .map(([f, v]) => `r['${f}'] === ${filterValueToCode(v)}`)
            .join(' && ');
          return `${name}: items.filter(r => ${conds}).length`;
        }
        if (spec.count) return `${name}: items.length`;
        if (spec.countBy) {
          const whereFilter = spec.where
            ? `.filter(r => ${Object.entries(spec.where)
                .map(([f, v]) => `r['${f}'] === ${filterValueToCode(v)}`)
                .join(' && ')})`
            : '';
          return `${name}: items${whereFilter}.reduce((acc, r) => { const k = String(r['${spec.countBy}']); acc[k] = (acc[k] || 0) + 1; return acc; }, {})`;
        }
      }
      return `${name}: 0`;
    })
    .join(', ');
}

function generateMemoryComputeSingle(compute: Record<string, unknown>): string {
  return Object.entries(compute)
    .map(([name, spec]) => {
      if (spec === 'count') return `${name}: records.length`;
      if (spec === 'sum')
        return `${name}: records.reduce((s, r) => s + (Number(r['${name}']) || 0), 0)`;
      if (spec === 'avg')
        return `${name}: records.length > 0 ? records.reduce((s, r) => s + (Number(r['${name}']) || 0), 0) / records.length : 0`;
      if (spec === 'min')
        return `${name}: Math.min(...records.map(r => Number(r['${name}']) || 0))`;
      if (spec === 'max')
        return `${name}: Math.max(...records.map(r => Number(r['${name}']) || 0))`;
      if (isComputedField(spec)) {
        if (spec.count && spec.where) {
          const conds = Object.entries(spec.where)
            .map(([f, v]) => `r['${f}'] === ${filterValueToCode(v)}`)
            .join(' && ');
          return `${name}: records.filter(r => ${conds}).length`;
        }
        if (spec.count) return `${name}: records.length`;
        if (spec.countBy) {
          const whereFilter = spec.where
            ? `.filter(r => ${Object.entries(spec.where)
                .map(([f, v]) => `r['${f}'] === ${filterValueToCode(v)}`)
                .join(' && ')})`
            : '';
          return `${name}: records${whereFilter}.reduce((acc, r) => { const k = String(r['${spec.countBy}']); acc[k] = (acc[k] || 0) + 1; return acc; }, {})`;
        }
      }
      return `${name}: 0`;
    })
    .join(', ');
}

function generateAggregateSqlite(
  opName: string,
  op: AggregateOpConfig,
  entity: ResolvedEntityConfig,
  paramList: string,
): string {
  const predicate = op.filter ? compileFilterMemory(op.filter) : 'true';
  const computeReducer = op.groupBy
    ? generateMemoryComputeReduce(op.compute)
    : generateMemoryComputeSingle(op.compute);

  let groupBlock: string;
  if (op.groupBy) {
    const field = getGroupByField(op.groupBy);
    const { helper, expr } = groupKeyParts(op.groupBy);
    groupBlock = `${helper}
      const groups = new Map();
      for (const r of records) {
        const key = ${expr};
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      const results = [];
      for (const [key, items] of groups) {
        results.push({ '${field}': key, ${computeReducer} });
      }
      return results;`;
  } else {
    groupBlock = `return { ${computeReducer} };`;
  }

  return `    async ${opName}(${paramList}) {
      ensureTable();
      const rows = db.query(\`SELECT * FROM \${table}\`).all();
      const records = [];
      for (const row of rows) {
        const record = row;
        if (${predicate}) records.push(record);
      }
      ${groupBlock}
    }`;
}

function generateAggregatePostgres(
  opName: string,
  op: AggregateOpConfig,
  entity: ResolvedEntityConfig,
  paramList: string,
): string {
  const predicate = op.filter ? compileFilterMemory(op.filter) : 'true';
  const computeReducer = op.groupBy
    ? generateMemoryComputeReduce(op.compute)
    : generateMemoryComputeSingle(op.compute);

  let groupBlock: string;
  if (op.groupBy) {
    const field = getGroupByField(op.groupBy);
    const { helper, expr } = groupKeyParts(op.groupBy);
    groupBlock = `${helper}
      const groups = new Map();
      for (const r of records) {
        const key = ${expr};
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      const results = [];
      for (const [key, items] of groups) {
        results.push({ '${field}': key, ${computeReducer} });
      }
      return results;`;
  } else {
    groupBlock = `return { ${computeReducer} };`;
  }

  return `    async ${opName}(${paramList}) {
      await ensureTable();
      const result = await pool.query(\`SELECT * FROM \${table}\`, []);
      const records = [];
      for (const row of result.rows) {
        const record = row;
        if (${predicate}) records.push(record);
      }
      ${groupBlock}
    }`;
}

function generateAggregateMongo(
  opName: string,
  op: AggregateOpConfig,
  _entity: ResolvedEntityConfig,
  paramList: string,
): string {
  const predicate = op.filter ? compileFilterMemory(op.filter) : 'true';
  const computeReducer = op.groupBy
    ? generateMemoryComputeReduce(op.compute)
    : generateMemoryComputeSingle(op.compute);

  let groupBlock: string;
  if (op.groupBy) {
    const field = getGroupByField(op.groupBy);
    const { helper, expr } = groupKeyParts(op.groupBy);
    groupBlock = `${helper}
      const groups = new Map();
      for (const r of records) {
        const key = ${expr};
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      const results = [];
      for (const [key, items] of groups) {
        results.push({ '${field}': key, ${computeReducer} });
      }
      return results;`;
  } else {
    groupBlock = `return { ${computeReducer} };`;
  }

  return `    async ${opName}(${paramList}) {
      const Model = getModel();
      const rows = await Model.find({}).lean();
      const records = [];
      for (const row of rows) {
        const record = row;
        if (${predicate}) records.push(record);
      }
      ${groupBlock}
    }`;
}
