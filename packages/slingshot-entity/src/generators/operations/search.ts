/**
 * op.search generator — full-text search with filter and pagination.
 *
 * Generated code: text search in DB, then JS post-filter using evaluateFilter
 * for complex filter expressions ($and/$or). Pagination via offset-based cursors.
 */
import { toSnakeCase } from '../../lib/naming';
import type { ResolvedEntityConfig } from '../../types/entity';
import type { SearchOpConfig } from '../../types/operations';
import type { Backend } from '../filter';

/**
 * Generate the search operation method body for a specific backend.
 *
 * A `search` operation performs full-text matching against `op.fields`, then
 * optionally applies an in-process post-filter using an inline `__matchFilter`
 * evaluator compiled from `op.filter`. Pagination is cursor-based
 * (base64url-encoded JSON offset) when `op.paginate` is set; otherwise the
 * result is limited by the `limit` parameter.
 *
 * Generated method signature:
 * `async {opName}(query, filterParams, limit[, cursor])`
 *
 * Backend implementations:
 * - `memory`: case-insensitive `String(r[field]).toLowerCase().includes(q)`
 *   check across all `op.fields`, iterating the in-memory store.
 * - `redis`: same JS predicate over `scanAllKeys()` + `redis.get()` results.
 * - `sqlite`: `SELECT * FROM … WHERE (col LIKE ? OR …)` with `'%' + query + '%'`
 *   bindings; post-filter and pagination applied in JS.
 * - `postgres`: `to_tsvector('english', …) @@ plainto_tsquery('english', $1)`
 *   full-text search; post-filter and pagination applied in JS.
 * - `mongo`: `Model.find({ $text: { $search: query } })` full-text search;
 *   post-filter and pagination applied in JS.
 *
 * @param opName - Operation name as declared in the entity config.
 * @param op - The search operation config (fields, optional filter, optional
 *   paginate flag).
 * @param entity - The resolved entity config.
 * @param backend - Target backend.
 * @returns A TypeScript source string for the operation method body.
 *
 * @remarks
 * The inline `__matchFilter` / `__resolveFilterValue` helpers are emitted
 * directly into the generated method body so the adapter has no runtime
 * dependency on external filter utilities. The filter expression is serialised
 * via `JSON.stringify(op.filter)` at code-generation time.
 */
export function generateSearch(
  opName: string,
  op: SearchOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const searchFields = op.fields;
  const hasFilter = op.filter && Object.keys(op.filter).length > 0;
  const paginate = op.paginate;
  const sig = `async ${opName}(query, filterParams, limit${paginate ? ', cursor' : ''})`;

  // Inline filter evaluator — self-contained, no external imports
  const filterCode = hasFilter
    ? `\n      const searchFilter = ${JSON.stringify(op.filter)};
      function __resolveFilterValue(v, params) {
        if (typeof v === 'string' && v.startsWith('param:')) return params[v.slice(6)];
        if (v === 'now') return new Date();
        return v;
      }
      function __matchFilter(record, filter, params) {
        for (const [k, v] of Object.entries(filter)) {
          if (k === '$and') { if (!v.every(sub => __matchFilter(record, sub, params))) return false; continue; }
          if (k === '$or') { if (!v.some(sub => __matchFilter(record, sub, params))) return false; continue; }
          const rv = __resolveFilterValue(v, params);
          if (rv === null) { if (record[k] != null) return false; continue; }
          if (typeof rv === 'object' && rv !== null) {
            if ('$ne' in rv) { if (record[k] === __resolveFilterValue(rv.$ne, params)) return false; continue; }
            if ('$gt' in rv) { if (!(record[k] > __resolveFilterValue(rv.$gt, params))) return false; continue; }
            if ('$gte' in rv) { if (!(record[k] >= __resolveFilterValue(rv.$gte, params))) return false; continue; }
            if ('$lt' in rv) { if (!(record[k] < __resolveFilterValue(rv.$lt, params))) return false; continue; }
            if ('$lte' in rv) { if (!(record[k] <= __resolveFilterValue(rv.$lte, params))) return false; continue; }
            if ('$in' in rv) { if (!rv.$in.includes(record[k])) return false; continue; }
            if ('$nin' in rv) { if (rv.$nin.includes(record[k])) return false; continue; }
            if ('$contains' in rv) { if (!String(record[k] ?? '').toLowerCase().includes(String(__resolveFilterValue(rv.$contains, params)).toLowerCase())) return false; continue; }
          }
          if (record[k] !== rv) return false;
        }
        return true;
      }
      const filtered = items.filter(item => __matchFilter(item, searchFilter, filterParams ?? {}));`
    : '\n      const filtered = items;';

  const paginateCode = paginate
    ? `
      const effectiveLimit = limit ?? 50;
      let startIdx = 0;
      if (cursor) { try { startIdx = JSON.parse(Buffer.from(cursor, 'base64url').toString()).offset ?? 0; } catch { console.warn('[search] failed to parse cursor, using offset 0:', cursor); } }
      const page = filtered.slice(startIdx, startIdx + effectiveLimit + 1);
      const hasMore = page.length > effectiveLimit;
      return { items: page.slice(0, effectiveLimit), nextCursor: hasMore ? Buffer.from(JSON.stringify({ offset: startIdx + effectiveLimit })).toString('base64url') : undefined, hasMore };`
    : `
      return limit ? filtered.slice(0, limit) : filtered;`;

  switch (backend) {
    case 'memory':
    case 'redis': {
      const fieldChecks = searchFields
        .map(f => `String(r['${f}'] ?? '').toLowerCase().includes(q)`)
        .join(' || ');

      const iteratorSetup =
        backend === 'memory'
          ? `const items = [];
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        const r = entry.record;
        if (${fieldChecks}) items.push({ ...r } as Entity);
      }`
          : `const allKeys = await scanAllKeys();
      const items = [];
      for (const key of allKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const r = fromRedisRecord(JSON.parse(raw));
        if (!isVisible(r)) continue;
        if (${fieldChecks}) items.push({ ...r } as Entity);
      }`;

      return `    ${sig} {
      const q = query.toLowerCase();
      ${iteratorSetup}${filterCode}${paginateCode}
    }`;
    }

    case 'sqlite': {
      const likeClauses = searchFields.map(f => `${toSnakeCase(f)} LIKE ?`).join(' OR ');
      const likeParams = searchFields.map(() => `'%' + query + '%'`);

      return `    ${sig} {
      ensureTable();
      const rows = db.query(\`SELECT * FROM \${table} WHERE (${likeClauses})\`).all(${likeParams.join(', ')});
      const items = rows.map(r => fromRow(r) as Entity);${filterCode}${paginateCode}
    }`;
    }

    case 'postgres': {
      const tsvectorCols = searchFields
        .map(f => `coalesce(${toSnakeCase(f)}, '')`)
        .join(" || ' ' || ");

      return `    ${sig} {
      await ensureTable();
      const result = await pool.query(
        \`SELECT * FROM \${table} WHERE to_tsvector('english', ${tsvectorCols}) @@ plainto_tsquery('english', $1)\`,
        [query]
      );
      const items = result.rows.map(r => fromRow(r) as Entity);${filterCode}${paginateCode}
    }`;
    }

    case 'mongo': {
      return `    ${sig} {
      const Model = getModel();
      const docs = await Model.find({ $text: { $search: query } }).lean();
      const items = docs.map(d => fromMongoDoc(d) as Entity);${filterCode}${paginateCode}
    }`;
    }
  }
}
