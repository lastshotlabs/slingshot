/**
 * Filter expression compiler — generates backend-specific filter code.
 *
 * Pure functions: FilterExpression → code string for each backend.
 * Used by operation generators that accept filter/match/where clauses.
 */
import type { ResolvedEntityConfig } from '../types/entity';
import type { FilterExpression, FilterOperator, FilterValue } from '../types/filter';

export type Backend = 'memory' | 'sqlite' | 'postgres' | 'mongo' | 'redis';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Type-guard: return `true` when `v` is a `'param:x'` reference string.
 *
 * @param v - The value to test.
 * @returns `true` if `v` is a string starting with `'param:'`, otherwise
 *   `false`.
 *
 * @example
 * ```ts
 * isParam('param:userId'); // true
 * isParam('active');       // false
 * isParam(42);             // false
 * ```
 */
function isParam(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('param:');
}

/**
 * Check if a string is a `'param:x'` reference without narrowing the type.
 *
 * Use this when you need to test a string without TypeScript removing `string`
 * from the type union in the false branch (which `isParam` would do as `v is string`).
 *
 * @param v - A string value to test.
 * @returns `true` if the string starts with `'param:'`.
 */
function checkParam(v: string): boolean {
  return v.startsWith('param:');
}

/**
 * Strip the `'param:'` prefix from a parameter reference string.
 *
 * @param v - A `'param:x'` reference string (must already be confirmed by
 *   `isParam()`).
 * @returns The bare parameter name (e.g. `'userId'` from `'param:userId'`).
 */
function paramName(v: string): string {
  return v.slice(6); // strip 'param:'
}

function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

/**
 * Type-guard: return `true` when `v` is a non-null, non-array object.
 *
 * Used to distinguish operator objects (`{ $gt: ... }`, `{ $in: [...] }`) from
 * primitive filter values.
 *
 * @param v - The value to test.
 * @returns `true` if `v` is a plain object (not `null` and not an array).
 */
function isOperator(v: unknown): v is FilterOperator {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readScalarOperatorValue(
  value: FilterOperator,
  operator: '$gt' | '$gte' | '$lt' | '$lte',
): string | number | undefined {
  switch (operator) {
    case '$gt':
      return '$gt' in value ? value.$gt : undefined;
    case '$gte':
      return '$gte' in value ? value.$gte : undefined;
    case '$lt':
      return '$lt' in value ? value.$lt : undefined;
    case '$lte':
      return '$lte' in value ? value.$lte : undefined;
  }
}

function readOperatorValues(value: FilterOperator): unknown[] {
  const values: unknown[] = [];
  if ('$eq' in value) values.push(value.$eq);
  if ('$ne' in value) values.push(value.$ne);
  if ('$gt' in value) values.push(value.$gt);
  if ('$gte' in value) values.push(value.$gte);
  if ('$lt' in value) values.push(value.$lt);
  if ('$lte' in value) values.push(value.$lte);
  if ('$in' in value) values.push(...value.$in);
  if ('$nin' in value) values.push(...value.$nin);
  if ('$contains' in value) values.push(value.$contains);
  return values;
}

/**
 * Convert a literal primitive value to its JavaScript code representation.
 *
 * Strings are wrapped in single quotes; numbers and booleans are stringified directly.
 *
 * @param v - A string, number, or boolean primitive.
 * @returns The code literal representation (e.g. `'hello'`, `42`, `true`).
 */
function literalToCode(v: string | number | boolean): string {
  return typeof v === 'string' ? `'${v}'` : String(v);
}

/**
 * Convert a param reference or literal to its code representation.
 *
 * If `v` is a `'param:x'` reference, emits the bare identifier. Otherwise,
 * calls {@link literalToCode}.
 *
 * @param v - A string or number value (param reference or literal).
 * @returns The code representation.
 */
function paramOrLiteral(v: string | number): string {
  return isParam(v) ? paramName(v) : literalToCode(v);
}

// ---------------------------------------------------------------------------
// Memory filter compiler
// ---------------------------------------------------------------------------

/**
 * Compile a single field/value pair to a JavaScript boolean expression for
 * in-process (memory/Redis) filtering.
 *
 * @param field - The record field name to compare against (e.g. `'status'`).
 * @param value - The `FilterValue` to compile: a literal, a `'param:x'`
 *   reference, `null`, or an operator object (`$ne`, `$gt`, `$in`, etc.).
 * @returns A JavaScript expression string that evaluates to a boolean when
 *   applied to a `record` variable, e.g.
 *   `"record['status'] === 'active'"`.
 */
function compileValueMemory(field: string, value: FilterValue): string {
  if (value === null) return `record['${field}'] == null`;
  if (typeof value === 'string') {
    return checkParam(value)
      ? `record['${field}'] === ${paramName(value)}`
      : `record['${field}'] === '${value}'`;
  }
  if (typeof value === 'number' || typeof value === 'boolean')
    return `record['${field}'] === ${String(value)}`;

  if (isOperator(value)) {
    if ('$ne' in value) {
      const v = value.$ne;
      if (v === null) return `record['${field}'] != null`;
      return `record['${field}'] !== ${literalToCode(v)}`;
    }
    if ('$gt' in value) {
      const rhs = value.$gt === 'now' ? 'new Date()' : paramOrLiteral(value.$gt);
      return `record['${field}'] > ${rhs}`;
    }
    if ('$gte' in value) {
      const rhs = value.$gte === 'now' ? 'new Date()' : paramOrLiteral(value.$gte);
      return `record['${field}'] >= ${rhs}`;
    }
    if ('$lt' in value) {
      const rhs = value.$lt === 'now' ? 'new Date()' : paramOrLiteral(value.$lt);
      return `record['${field}'] < ${rhs}`;
    }
    if ('$lte' in value) {
      const rhs = value.$lte === 'now' ? 'new Date()' : paramOrLiteral(value.$lte);
      return `record['${field}'] <= ${rhs}`;
    }
    if ('$in' in value) {
      const arr = value.$in.map(v => literalToCode(v)).join(', ');
      return `[${arr}].includes(record['${field}'])`;
    }
    if ('$nin' in value) {
      const arr = value.$nin.map(v => literalToCode(v)).join(', ');
      return `![${arr}].includes(record['${field}'])`;
    }
    if ('$contains' in value) {
      const contains = value.$contains;
      const rhs = checkParam(contains) ? paramName(contains) : `'${contains}'`;
      return `String(record['${field}']).toLowerCase().includes(String(${rhs}).toLowerCase())`;
    }
  }

  return `record['${field}'] === ${JSON.stringify(value)}`;
}

/**
 * Compile a filter expression to an in-process JavaScript predicate expression.
 *
 * Produces a boolean expression string that operates on a `record` variable
 * (typed as `Record<string, unknown>`). `param:x` references are emitted as
 * bare identifier `x`, which must be in scope when the generated code runs.
 *
 * @param filter - The filter expression to compile.
 * @returns A JavaScript expression string such as
 *   `"record['status'] === 'active' && record['score'] > 10"`.
 *   Returns `'true'` when the filter is empty.
 *
 * @remarks
 * Supports operators: `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`,
 * `$contains`, `$and`, `$or`. The `'now'` special value is emitted as
 * `new Date()`.
 *
 * @example
 * ```ts
 * import { compileFilterMemory } from '@lastshotlabs/slingshot-entity';
 *
 * const predicate = compileFilterMemory({ status: 'active', score: { $gt: 10 } });
 * // "record['status'] === 'active' && record['score'] > 10"
 * ```
 */
export function compileFilterMemory(filter: FilterExpression): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') continue;
    parts.push(compileValueMemory(key, value as FilterValue));
  }

  if (filter.$and) {
    for (const sub of filter.$and) {
      parts.push(`(${compileFilterMemory(sub)})`);
    }
  }

  let result = parts.join(' && ');

  if (filter.$or) {
    const orParts = filter.$or.map(sub => `(${compileFilterMemory(sub)})`);
    const orExpr = orParts.join(' || ');
    result = result ? `(${result}) && (${orExpr})` : orExpr;
  }

  return result || 'true';
}

// ---------------------------------------------------------------------------
// SQL filter compiler (shared by SQLite and Postgres)
// ---------------------------------------------------------------------------

interface SqlCompileContext {
  readonly conditions: string[];
  readonly params: string[];
  readonly entity: ResolvedEntityConfig;
  readonly paramStyle: 'positional' | 'question'; // $1 vs ?
  paramIdx: number;
}

/**
 * Advance the SQL parameter index and return the placeholder token.
 *
 * Mutates `ctx.paramIdx` as a side effect.
 *
 * @param ctx - The mutable SQL compile context carrying the current parameter
 *   index and the placeholder style.
 * @returns `'?'` for SQLite (`'question'` style) or `'$N'` for PostgreSQL
 *   (`'positional'` style), where `N` is the incremented index.
 */
function sqlParam(ctx: SqlCompileContext): string {
  ctx.paramIdx++;
  return ctx.paramStyle === 'positional' ? `$${ctx.paramIdx}` : '?';
}

/**
 * Compile a single field/value pair into SQL conditions and append them to the
 * shared `SqlCompileContext`.
 *
 * Mutates `ctx.conditions` and `ctx.params` as side effects and advances
 * `ctx.paramIdx` via `sqlParam()`.
 *
 * @param ctx - The mutable SQL compile context (conditions, params, paramIdx,
 *   paramStyle, entity).
 * @param field - The camelCase field name to compile (converted to snake_case
 *   for the SQL column).
 * @param value - The `FilterValue` to compile: a literal, `null`, a
 *   `'param:x'` reference, or an operator object.
 */
function compileSqlValue(ctx: SqlCompileContext, field: string, value: FilterValue): void {
  const col = toSnakeCase(field);

  if (value === null) {
    ctx.conditions.push(`${col} IS NULL`);
    return;
  }

  if (typeof value === 'string') {
    ctx.conditions.push(`${col} = ${sqlParam(ctx)}`);
    ctx.params.push(checkParam(value) ? paramName(value) : `'${value}'`);
    return;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    ctx.conditions.push(`${col} = ${sqlParam(ctx)}`);
    ctx.params.push(String(value));
    return;
  }

  if (isOperator(value)) {
    if ('$ne' in value) {
      const v = value.$ne;
      if (v === null) {
        ctx.conditions.push(`${col} IS NOT NULL`);
      } else {
        ctx.conditions.push(`${col} != ${sqlParam(ctx)}`);
        ctx.params.push(literalToCode(v));
      }
      return;
    }

    const sqlOpMap: Record<string, string> = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' };
    for (const [opKey, sqlOp] of Object.entries(sqlOpMap)) {
      if (opKey in value) {
        const v = readScalarOperatorValue(value, opKey as '$gt' | '$gte' | '$lt' | '$lte');
        if (v === undefined) {
          continue;
        }
        if (v === 'now') {
          ctx.conditions.push(
            ctx.paramStyle === 'positional'
              ? `${col} ${sqlOp} NOW()`
              : `${col} ${sqlOp} ${sqlParam(ctx)}`,
          );
          if (ctx.paramStyle === 'question') ctx.params.push('Date.now()');
        } else {
          ctx.conditions.push(`${col} ${sqlOp} ${sqlParam(ctx)}`);
          ctx.params.push(paramOrLiteral(v));
        }
        return;
      }
    }

    if ('$in' in value) {
      const arr = value.$in;
      if (ctx.paramStyle === 'positional') {
        ctx.conditions.push(`${col} = ANY(${sqlParam(ctx)})`);
        ctx.params.push(`[${arr.join(', ')}]`);
      } else {
        const placeholders = arr.map(() => sqlParam(ctx)).join(', ');
        ctx.conditions.push(`${col} IN (${placeholders})`);
        for (const v of arr) ctx.params.push(String(v));
      }
      return;
    }

    if ('$nin' in value) {
      const arr = value.$nin;
      if (ctx.paramStyle === 'positional') {
        ctx.conditions.push(`${col} != ALL(${sqlParam(ctx)})`);
        ctx.params.push(`[${arr.join(', ')}]`);
      } else {
        const placeholders = arr.map(() => sqlParam(ctx)).join(', ');
        ctx.conditions.push(`${col} NOT IN (${placeholders})`);
        for (const v of arr) ctx.params.push(String(v));
      }
      return;
    }

    if ('$contains' in value) {
      const v = value.$contains;
      ctx.conditions.push(`LOWER(${col}) LIKE ${sqlParam(ctx)}`);
      ctx.params.push(
        checkParam(v) ? `\`%\${${paramName(v)}.toLowerCase()}%\`` : `'%${v.toLowerCase()}%'`,
      );
      return;
    }
  }
}

/**
 * Recursively compile a `FilterExpression` into SQL conditions and params.
 *
 * Processes top-level field entries, then `$and` sub-expressions (wrapped in
 * parentheses and joined with `AND`), then `$or` sub-expressions (joined with
 * `OR`). All results are appended to `ctx.conditions` and `ctx.params`.
 *
 * @param ctx - The mutable SQL compile context shared across the recursion.
 * @param filter - The `FilterExpression` to compile.
 */
function compileSqlFilter(ctx: SqlCompileContext, filter: FilterExpression): void {
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') continue;
    compileSqlValue(ctx, key, value as FilterValue);
  }

  if (filter.$and) {
    for (const sub of filter.$and) {
      const subCtx: SqlCompileContext = { ...ctx, conditions: [] };
      compileSqlFilter(subCtx, sub);
      ctx.paramIdx = subCtx.paramIdx;
      ctx.params.push(...subCtx.params);
      if (subCtx.conditions.length > 0) {
        ctx.conditions.push(`(${subCtx.conditions.join(' AND ')})`);
      }
    }
  }

  if (filter.$or) {
    const orParts: string[] = [];
    for (const sub of filter.$or) {
      const subCtx: SqlCompileContext = { ...ctx, conditions: [] };
      compileSqlFilter(subCtx, sub);
      ctx.paramIdx = subCtx.paramIdx;
      ctx.params.push(...subCtx.params);
      if (subCtx.conditions.length > 0) {
        orParts.push(`(${subCtx.conditions.join(' AND ')})`);
      }
    }
    if (orParts.length > 0) {
      ctx.conditions.push(`(${orParts.join(' OR ')})`);
    }
  }
}

export interface SqlFilterResult {
  readonly where: string;
  readonly params: readonly string[];
  readonly paramIdx: number;
}

/**
 * Compile a filter expression to a SQLite `WHERE` clause and positional
 * parameter list.
 *
 * Uses `?` placeholders. `param:x` references are emitted as the identifier `x`
 * (a runtime variable name), which is added to the returned `params` array as
 * a reference string. CamelCase field names are converted to snake_case.
 *
 * @param filter - The filter expression to compile.
 * @param entity - The resolved entity config (used for type lookups, currently
 *   stored in context but not yet used directly).
 * @param startParamIdx - Initial parameter index for chained compilations.
 *   Defaults to `0`.
 * @returns A `SqlFilterResult` with `where` (the SQL condition string),
 *   `params` (array of parameter value expressions), and `paramIdx` (the next
 *   available parameter index after compilation).
 *
 * @example
 * ```ts
 * import { compileFilterSqlite } from '@lastshotlabs/slingshot-entity';
 *
 * const { where, params } = compileFilterSqlite({ userId: 'param:userId' }, config);
 * // where: "user_id = ?", params: ["userId"]
 * ```
 */
export function compileFilterSqlite(
  filter: FilterExpression,
  entity: ResolvedEntityConfig,
  startParamIdx?: number,
): SqlFilterResult {
  const ctx: SqlCompileContext = {
    conditions: [],
    params: [],
    entity,
    paramStyle: 'question',
    paramIdx: startParamIdx ?? 0,
  };
  compileSqlFilter(ctx, filter);
  return {
    where: ctx.conditions.length > 0 ? ctx.conditions.join(' AND ') : '1=1',
    params: ctx.params,
    paramIdx: ctx.paramIdx,
  };
}

/**
 * Compile a filter expression to a PostgreSQL `WHERE` clause and positional
 * parameter list.
 *
 * Uses `$N` positional placeholders (e.g. `$1`, `$2`). `param:x` references
 * are emitted as the identifier `x`. CamelCase field names are converted to
 * snake_case. The special `'now'` value uses `NOW()` for positional style.
 * Arrays (for `$in` / `$nin`) use the `ANY($N)` / `!= ALL($N)` forms.
 *
 * @param filter - The filter expression to compile.
 * @param entity - The resolved entity config (used for type lookups).
 * @param startParamIdx - Initial parameter index, defaults to `0`.
 * @returns A `SqlFilterResult` with `where`, `params`, and `paramIdx`.
 *
 * @example
 * ```ts
 * import { compileFilterPostgres } from '@lastshotlabs/slingshot-entity';
 *
 * const { where, params } = compileFilterPostgres({ status: 'active', score: { $gt: 0 } }, config);
 * // where: "status = $1 AND score > $2", params: ["'active'", "0"]
 * ```
 */
export function compileFilterPostgres(
  filter: FilterExpression,
  entity: ResolvedEntityConfig,
  startParamIdx?: number,
): SqlFilterResult {
  const ctx: SqlCompileContext = {
    conditions: [],
    params: [],
    entity,
    paramStyle: 'positional',
    paramIdx: startParamIdx ?? 0,
  };
  compileSqlFilter(ctx, filter);
  return {
    where: ctx.conditions.length > 0 ? ctx.conditions.join(' AND ') : 'TRUE',
    params: ctx.params,
    paramIdx: ctx.paramIdx,
  };
}

// ---------------------------------------------------------------------------
// MongoDB filter compiler
// ---------------------------------------------------------------------------

/**
 * Compile a single field/value pair to a MongoDB query object property string.
 *
 * @param field - The field name as it appears in MongoDB documents (typically
 *   matching the entity field name, since Mongoose keeps camelCase).
 * @param value - The `FilterValue` to compile: a literal, `null`, a
 *   `'param:x'` reference, or an operator object.
 * @returns A string fragment suitable for embedding inside a MongoDB query
 *   object literal, e.g. `"status: 'active'"` or
 *   `"score: { $gt: minScore }"`.
 */
function compileMongoValue(field: string, value: FilterValue): string {
  if (value === null) return `${field}: null`;
  if (typeof value === 'string') {
    return checkParam(value) ? `${field}: ${paramName(value)}` : `${field}: '${value}'`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return `${field}: ${String(value)}`;

  if (isOperator(value)) {
    if ('$ne' in value) {
      const v = value.$ne;
      if (v === null) return `${field}: { $ne: null }`;
      return `${field}: { $ne: ${literalToCode(v)} }`;
    }

    const mongoOpMap: Record<string, string> = {
      $gt: '$gt',
      $gte: '$gte',
      $lt: '$lt',
      $lte: '$lte',
    };
    for (const [opKey, mongoOp] of Object.entries(mongoOpMap)) {
      if (opKey in value) {
        const v = readScalarOperatorValue(value, opKey as '$gt' | '$gte' | '$lt' | '$lte');
        if (v === undefined) {
          continue;
        }
        const rhs = v === 'now' ? 'new Date()' : paramOrLiteral(v);
        return `${field}: { ${mongoOp}: ${rhs} }`;
      }
    }

    if ('$in' in value) {
      const arr = value.$in.map(v => literalToCode(v));
      return `${field}: { $in: [${arr.join(', ')}] }`;
    }
    if ('$nin' in value) {
      const arr = value.$nin.map(v => literalToCode(v));
      return `${field}: { $nin: [${arr.join(', ')}] }`;
    }
    if ('$contains' in value) {
      const contains = value.$contains;
      const rhs = checkParam(contains) ? paramName(contains) : `'${contains}'`;
      return `${field}: { $regex: ${rhs}, $options: 'i' }`;
    }
  }

  return `${field}: ${JSON.stringify(value)}`;
}

/**
 * Compile a filter expression to a MongoDB query object literal string.
 *
 * Produces a JavaScript object literal string (not JSON — it may contain bare
 * identifiers for `param:x` references). `param:x` references are emitted as
 * bare variable name `x`. The `'now'` special value emits `new Date()`.
 *
 * @param filter - The filter expression to compile.
 * @returns A JavaScript object literal string such as
 *   `"{ status: 'active', score: { $gt: 10 } }"`.
 *
 * @example
 * ```ts
 * import { compileFilterMongo } from '@lastshotlabs/slingshot-entity';
 *
 * const query = compileFilterMongo({ status: 'active', userId: 'param:userId' });
 * // "{ status: 'active', userId: userId }"
 * ```
 */
export function compileFilterMongo(filter: FilterExpression): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') continue;
    parts.push(compileMongoValue(key, value as FilterValue));
  }

  if (filter.$and) {
    const andParts = filter.$and.map(sub => compileFilterMongo(sub));
    parts.push(`$and: [${andParts.join(', ')}]`);
  }

  if (filter.$or) {
    const orParts = filter.$or.map(sub => compileFilterMongo(sub));
    parts.push(`$or: [${orParts.join(', ')}]`);
  }

  return `{ ${parts.join(', ')} }`;
}

// ---------------------------------------------------------------------------
// Redis filter compiler (same as memory — filters run in JS after SCAN)
// ---------------------------------------------------------------------------

/**
 * Compile a filter expression for the Redis backend.
 *
 * Redis stores records as JSON strings and retrieves them with `SCAN` +
 * `GET`, so filtering is performed in JavaScript after deserialization —
 * the same in-process predicate logic as the memory backend.
 *
 * Alias for `compileFilterMemory`.
 */
export const compileFilterRedis = compileFilterMemory;

// ---------------------------------------------------------------------------
// Param extraction — find all 'param:x' references in a filter
// ---------------------------------------------------------------------------

/**
 * Extract all `param:x` parameter names from a filter expression.
 *
 * Recursively walks the entire filter (including `$and` / `$or` branches and
 * operator objects like `{ $gt: 'param:threshold' }`) to collect every
 * `param:x` reference. Duplicates are removed.
 *
 * @param filter - The filter expression to inspect.
 * @returns A deduplicated array of parameter name strings (without the
 *   `'param:'` prefix), e.g. `['userId', 'status']`.
 *
 * @example
 * ```ts
 * import { extractParams } from '@lastshotlabs/slingshot-entity';
 *
 * const params = extractParams({ userId: 'param:userId', score: { $gt: 'param:minScore' } });
 * // ['userId', 'minScore']
 * ```
 */
export function extractParams(filter: FilterExpression): string[] {
  const params: string[] = [];

  for (const value of Object.values(filter)) {
    if (typeof value === 'string' && isParam(value)) {
      params.push(paramName(value));
    } else if (isOperator(value)) {
      for (const v of readOperatorValues(value)) {
        if (typeof v === 'string' && isParam(v)) {
          params.push(paramName(v));
        }
      }
    }
  }

  if (filter.$and) {
    for (const sub of filter.$and) params.push(...extractParams(sub));
  }
  if (filter.$or) {
    for (const sub of filter.$or) params.push(...extractParams(sub));
  }

  return [...new Set(params)];
}

/**
 * Extract `param:x` parameter names from a match record.
 *
 * Match records map field names to either a literal value or `'param:x'`.
 * This function collects only the `param:x` references and strips the prefix.
 * Used by transition, lookup, and fieldUpdate generators to build function
 * parameter lists.
 *
 * @param match - A `Record<string, string>` mapping field names to values or
 *   `'param:x'` references (e.g. `{ id: 'param:id', status: 'active' }`).
 * @returns An array of parameter name strings for the `param:` references only
 *   (e.g. `['id']`).
 *
 * @example
 * ```ts
 * import { extractMatchParams } from '@lastshotlabs/slingshot-entity';
 *
 * const params = extractMatchParams({ id: 'param:id', status: 'active' });
 * // ['id']
 * ```
 */
export function extractMatchParams(match: Record<string, unknown>): string[] {
  const params: string[] = [];
  for (const v of Object.values(match)) {
    if (isParam(v)) params.push(paramName(v));
  }
  return params;
}
