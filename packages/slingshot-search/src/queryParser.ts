/**
 * URL filter syntax parser.
 *
 * Parses compact, GET-friendly filter strings into SearchFilter objects.
 *
 * Syntax:
 *   field:value                    -> equality
 *   field:!=value                  -> not equal
 *   field:>N                       -> greater than
 *   field:>=N                      -> greater or equal
 *   field:<N                       -> less than
 *   field:<=N                      -> less or equal
 *   field:in(a,b,c)               -> IN set
 *   field:!in(a,b,c)              -> NOT IN set
 *   field:between(min,max)         -> range
 *   field:starts_with(prefix)      -> prefix match
 *   field:exists                   -> field exists
 *   field:empty                    -> empty value
 *
 * Multiple filters comma-separated at the top level are AND'd.
 * Example: "status:published,containerId:abc,score:>=10"
 */
import type { SearchFilter, SearchFilterCondition, SearchFilterValue } from './types/query';

// ============================================================================
// Parser error
// ============================================================================

/**
 * Thrown when `parseUrlFilter()` cannot parse a filter string.
 *
 * Captures the original filter string and the (optional) character position
 * where parsing failed so callers can produce useful error messages.
 *
 * @example
 * ```ts
 * try {
 *   parseUrlFilter('status');
 * } catch (err) {
 *   if (err instanceof FilterParseError) {
 *     console.error(err.filterString); // 'status'
 *   }
 * }
 * ```
 */
export class FilterParseError extends Error {
  constructor(
    message: string,
    public readonly filterString: string,
    public readonly position?: number,
  ) {
    super(`[slingshot-search] Filter parse error: ${message}`);
    this.name = 'FilterParseError';
  }
}

// ============================================================================
// Value coercion
// ============================================================================

/**
 * Coerce a raw string token into its most natural scalar type.
 *
 * The conversion rules are applied in priority order:
 * 1. `'null'` → `null`
 * 2. `'true'` / `'false'` → `boolean`
 * 3. Any non-empty string that parses as a finite number → `number`
 * 4. Everything else → the original `string`
 *
 * This function is intentionally not exported — it is an implementation
 * detail of the filter parser. Values are coerced at parse time so that
 * `status:true` produces a `boolean` filter value rather than the string
 * `"true"`, and `score:>=10` produces a numeric `10`.
 *
 * @param raw - The raw string token extracted from a filter expression.
 * @returns The coerced value in its natural type.
 *
 * @remarks
 * Empty strings are not coerced to numbers (the `raw.trim() !== ''` guard
 * prevents `Number('')` from returning `0`). Whitespace-only strings follow
 * the same rule — they remain as strings.
 *
 * @example
 * ```ts
 * coerceValue('null')    // null
 * coerceValue('true')    // true
 * coerceValue('42')      // 42
 * coerceValue('hello')   // 'hello'
 * coerceValue('')        // ''
 * ```
 */
function coerceValue(raw: string): string | number | boolean | null {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // Try numeric coercion
  const num = Number(raw);
  if (!Number.isNaN(num) && raw.trim() !== '') return num;

  return raw;
}

/**
 * Parse the inner contents of a parenthesized argument list.
 *
 * Given the content between the outer parentheses of an expression like
 * `in(a,b,c)` or `between(1,100)`, this function splits on top-level commas
 * and returns the trimmed argument strings.
 *
 * The parser tracks nesting depth and quoted regions to avoid splitting on
 * commas that appear inside nested parentheses or string literals.
 *
 * @param input - The content between the outermost `(` and `)`, e.g. `'a,b,c'`.
 * @returns The individual argument strings, each trimmed of leading/trailing
 *   whitespace. An empty input produces an empty array.
 *
 * @remarks
 * **Quoted strings** — both single (`'`) and double (`"`) quotes are supported.
 * Characters inside quotes are treated as opaque: commas inside quotes are not
 * treated as separators, and the closing quote character ends the quoted region.
 * Escaped quotes inside a quoted region are **not** currently supported — a
 * `\"` inside a double-quoted string would end the quoted region prematurely.
 * For URL-encoded filter values this is not an issue in practice because callers
 * URL-decode before parsing.
 *
 * **Nested parentheses** — the depth counter is incremented on `(` and
 * decremented on `)`. A `)` that would take depth below zero is ignored
 * (treated as a literal character that was already consumed by the outer
 * `parseSingleFilter` caller).
 *
 * @example
 * ```ts
 * parseArgList('a,b,c')           // ['a', 'b', 'c']
 * parseArgList('1, 100')           // ['1', '100']
 * parseArgList('"hello,world",x')  // ['hello,world', 'x']
 * parseArgList('fn(a,b),c')        // ['fn(a,b)', 'c']
 * ```
 */
function parseArgList(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      current += ch;
      continue;
    }

    if (ch === ')') {
      if (depth > 0) {
        depth--;
        current += ch;
      }
      continue;
    }

    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

// ============================================================================
// Single filter expression parser
// ============================================================================

/**
 * Parse a single "field:expression" filter token into a SearchFilterCondition.
 */
function parseSingleFilter(token: string, fullString: string): SearchFilterCondition {
  // Find the first colon that separates field from expression.
  // Handle case where field name might contain dots (nested fields).
  const colonIdx = token.indexOf(':');
  if (colonIdx === -1 || colonIdx === 0) {
    throw new FilterParseError(
      `Invalid filter token: '${token}'. Expected 'field:expression'`,
      fullString,
    );
  }

  const field = token.slice(0, colonIdx);
  const expression = token.slice(colonIdx + 1);

  if (!expression) {
    throw new FilterParseError(`Empty expression for field '${field}'`, fullString);
  }

  // --- Keyword operators (no value needed) ---
  if (expression === 'exists') {
    return { field, op: 'EXISTS', value: null };
  }
  if (expression === 'empty') {
    return { field, op: 'IS_EMPTY', value: null };
  }
  if (expression === '!exists') {
    return { field, op: 'NOT_EXISTS', value: null };
  }
  if (expression === '!empty') {
    return { field, op: 'IS_NOT_EMPTY', value: null };
  }

  // --- Function-style operators ---

  // in(a,b,c)
  if (expression.startsWith('in(') && expression.endsWith(')')) {
    const inner = expression.slice(3, -1);
    const values = parseArgList(inner).map(coerceValue);
    return { field, op: 'IN', value: values as ReadonlyArray<string | number | boolean> };
  }

  // !in(a,b,c)
  if (expression.startsWith('!in(') && expression.endsWith(')')) {
    const inner = expression.slice(4, -1);
    const values = parseArgList(inner).map(coerceValue);
    return { field, op: 'NOT_IN', value: values as ReadonlyArray<string | number | boolean> };
  }

  // between(min,max)
  if (expression.startsWith('between(') && expression.endsWith(')')) {
    const inner = expression.slice(8, -1);
    const args = parseArgList(inner);
    if (args.length !== 2) {
      throw new FilterParseError(
        `between() requires exactly 2 arguments, got ${args.length} for field '${field}'`,
        fullString,
      );
    }
    const min = Number(args[0]);
    const max = Number(args[1]);
    if (Number.isNaN(min) || Number.isNaN(max)) {
      throw new FilterParseError(
        `between() arguments must be numeric for field '${field}'`,
        fullString,
      );
    }
    return { field, op: 'BETWEEN', value: [min, max] as readonly [number, number] };
  }

  // starts_with(prefix)
  if (expression.startsWith('starts_with(') && expression.endsWith(')')) {
    const inner = expression.slice(12, -1);
    return { field, op: 'STARTS_WITH', value: inner };
  }

  // contains(value)
  if (expression.startsWith('contains(') && expression.endsWith(')')) {
    const inner = expression.slice(9, -1);
    return { field, op: 'CONTAINS', value: coerceValue(inner) as SearchFilterValue };
  }

  // --- Comparison operators ---

  // != (must check before > and <)
  if (expression.startsWith('!=')) {
    const raw = expression.slice(2);
    return { field, op: '!=', value: coerceValue(raw) };
  }

  // >=
  if (expression.startsWith('>=')) {
    const raw = expression.slice(2);
    const value = Number(raw);
    if (Number.isNaN(value)) {
      throw new FilterParseError(
        `'>=' requires a numeric value for field '${field}', got '${raw}'`,
        fullString,
      );
    }
    return { field, op: '>=', value };
  }

  // <=
  if (expression.startsWith('<=')) {
    const raw = expression.slice(2);
    const value = Number(raw);
    if (Number.isNaN(value)) {
      throw new FilterParseError(
        `'<=' requires a numeric value for field '${field}', got '${raw}'`,
        fullString,
      );
    }
    return { field, op: '<=', value };
  }

  // >
  if (expression.startsWith('>')) {
    const raw = expression.slice(1);
    const value = Number(raw);
    if (Number.isNaN(value)) {
      throw new FilterParseError(
        `'>' requires a numeric value for field '${field}', got '${raw}'`,
        fullString,
      );
    }
    return { field, op: '>', value };
  }

  // <
  if (expression.startsWith('<')) {
    const raw = expression.slice(1);
    const value = Number(raw);
    if (Number.isNaN(value)) {
      throw new FilterParseError(
        `'<' requires a numeric value for field '${field}', got '${raw}'`,
        fullString,
      );
    }
    return { field, op: '<', value };
  }

  // --- Default: equality ---
  return { field, op: '=', value: coerceValue(expression) };
}

// ============================================================================
// Top-level parser
// ============================================================================

/**
 * Parse a compact URL filter string into a `SearchFilter` AST.
 *
 * Designed for use with query-string parameters where a full JSON body is not
 * practical. The syntax is intentionally compact and GET-friendly.
 *
 * **Syntax reference:**
 * | Expression | Operator | Notes |
 * |---|---|---|
 * | `field:value` | `=` (equality) | Value is coerced via `coerceValue` |
 * | `field:!=value` | `!=` | |
 * | `field:>N` | `>` | N must be numeric |
 * | `field:>=N` | `>=` | N must be numeric |
 * | `field:<N` | `<` | N must be numeric |
 * | `field:<=N` | `<=` | N must be numeric |
 * | `field:in(a,b,c)` | `IN` | Values coerced individually |
 * | `field:!in(a,b,c)` | `NOT_IN` | |
 * | `field:between(min,max)` | `BETWEEN` | Both args must be numeric |
 * | `field:starts_with(prefix)` | `STARTS_WITH` | |
 * | `field:contains(value)` | `CONTAINS` | |
 * | `field:exists` | `EXISTS` | No value |
 * | `field:empty` | `IS_EMPTY` | No value |
 * | `field:!exists` | `NOT_EXISTS` | No value |
 * | `field:!empty` | `IS_NOT_EMPTY` | No value |
 *
 * Multiple filters **comma-separated at the top level** are AND'd together.
 * Commas inside parentheses (e.g. `in(a,b)`) are treated as argument separators
 * and do not produce extra AND clauses.
 *
 * @param filterString - The raw filter string from a URL query parameter.
 *   Pass `undefined` or an empty string to receive `undefined` back.
 * @returns A `SearchFilter` AST, or `undefined` when the input is empty.
 *
 * @throws {FilterParseError} When a token is malformed — e.g. missing the
 *   colon separator, an empty expression after the colon, non-numeric args to
 *   `>`, `>=`, `<`, `<=`, or a wrong argument count to `between()`.
 *
 * @remarks
 * **AND/OR precedence** — only AND (`$and`) is expressible at the top level.
 * OR and NOT are not expressible in URL filter syntax; construct a
 * `SearchFilter` object directly when you need those operators.
 *
 * **Nested field paths** — dot-separated paths (e.g. `meta.status`) are passed
 * through verbatim as the `field` property. The parser treats everything before
 * the first `:` as the field name, so `meta.status:published` produces
 * `{ field: 'meta.status', op: '=', value: 'published' }`.
 *
 * **Escaped quotes** — quotes inside `in()` / `between()` / `starts_with()`
 * argument lists delimit string boundaries but the quote characters themselves
 * are stripped from the parsed value. There is no backslash-escape syntax.
 *
 * **Single vs. multiple conditions** — when the input contains exactly one
 * filter token, the result is the bare `SearchFilterCondition` (not wrapped in
 * `$and`). Multiple tokens produce `{ $and: [...] }`.
 *
 * @example
 * ```ts
 * // Single condition
 * parseUrlFilter('status:published');
 * // { field: 'status', op: '=', value: 'published' }
 *
 * // Multiple AND'd conditions
 * parseUrlFilter('status:published,score:>=10,containerId:in(abc,def)');
 * // { $and: [
 * //   { field: 'status', op: '=', value: 'published' },
 * //   { field: 'score', op: '>=', value: 10 },
 * //   { field: 'containerId', op: 'IN', value: ['abc', 'def'] },
 * // ]}
 *
 * // Empty / missing input
 * parseUrlFilter(undefined); // undefined
 * parseUrlFilter('');        // undefined
 * ```
 */
export function parseUrlFilter(filterString: string | undefined): SearchFilter | undefined {
  if (!filterString || filterString.trim() === '') return undefined;

  const input = filterString.trim();

  // Split on commas that are NOT inside parentheses
  const tokens: string[] = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      if (current.trim()) tokens.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) tokens.push(current.trim());

  if (tokens.length === 0) return undefined;

  const conditions = tokens.map(t => parseSingleFilter(t, input));

  if (conditions.length === 1) {
    return conditions[0];
  }

  return { $and: conditions };
}

/**
 * Parse a compact URL sort string into a `SearchSort` array.
 *
 * Each sort criterion is expressed as `field:direction` where `direction` is
 * either `'asc'` or `'desc'`. Multiple criteria are separated by commas and
 * applied in declaration order (leftmost = primary sort).
 *
 * @param sortString - The raw sort string from a URL query parameter.
 *   Pass `undefined` or an empty string to receive `undefined` back.
 * @returns An ordered array of `{ field, direction }` objects, or `undefined`
 *   when the input is empty.
 *
 * @remarks
 * **Direction default** — any direction value other than `'desc'` is treated
 * as `'asc'`. There is no error for unknown direction strings.
 *
 * **Geo sorts** — this parser only handles named field sorts. Geo-point sort
 * (`{ geoPoint, direction }`) cannot be expressed in the URL sort syntax and
 * must be constructed programmatically.
 *
 * @example
 * ```ts
 * parseUrlSort('score:desc,createdAt:asc');
 * // [{ field: 'score', direction: 'desc' }, { field: 'createdAt', direction: 'asc' }]
 *
 * parseUrlSort('name');      // [{ field: 'name', direction: 'asc' }]
 * parseUrlSort(undefined);   // undefined
 * ```
 */
export function parseUrlSort(
  sortString: string | undefined,
): ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }> | undefined {
  if (!sortString || sortString.trim() === '') return undefined;

  return sortString
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(token => {
      const parts = token.split(':');
      const field = parts[0];
      const direction = parts[1] === 'desc' ? 'desc' : 'asc';
      return { field, direction } as const;
    });
}
