/**
 * op.derive generator — multi-source read + merge.
 *
 * Reads from multiple sources (potentially different entities),
 * merges results using a specified strategy.
 */
import type { ResolvedEntityConfig } from '../../types/entity';
import type { DeriveOpConfig } from '../../types/operations';
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
 * - `sqlite` / `postgres` / `mongo`: emits stub placeholders with `TODO: query
 *   {source.from}` comments — these require manual completion in the generated
 *   adapter since cross-entity queries depend on runtime adapter composition
 *   that is not available at code-generation time.
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
    case 'postgres':
    case 'mongo':
      return generateDeriveGeneric(opName, op, entity, backend, paramList, mergeCode);
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

function generateDeriveGeneric(
  opName: string,
  op: DeriveOpConfig,
  _entity: ResolvedEntityConfig,
  backend: Backend,
  paramList: string,
  mergeCode: string,
): string {
  // For SQL/Mongo backends, derive ops run multiple queries and merge in JS
  // This is the general-purpose approach; optimized backends could use JOINs
  const sourceArrays = op.sources.map((_, i) => `source${i}`);

  return `    async ${opName}(${paramList}) {
      // Multi-source derive — runs ${op.sources.length} queries and merges results
      ${op.sources.map((source, i) => `const source${i} = []; // TODO: query ${source.from}`).join('\n      ')}
      const sourceResults = [${sourceArrays.join(', ')}];
      ${mergeCode}
      return merged;
    }`;
}
