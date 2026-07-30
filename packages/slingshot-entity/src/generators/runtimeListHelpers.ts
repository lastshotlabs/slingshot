/** Append the dependency-free filter evaluator used by generated adapters. */
export function appendRuntimeFilterEvaluator(lines: string[]): void {
  lines.push(
    '  function compareFilterValues(a: unknown, b: unknown): number {',
    '    if (a instanceof Date || b instanceof Date) return new Date(String(a)).getTime() - new Date(String(b)).getTime();',
    "    if (typeof a === 'number' && typeof b === 'number') return a - b;",
    '    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;',
    '  }',
    '',
    '  function matchesFilterValue(recordValue: unknown, filterValue: unknown): boolean {',
    '    if (filterValue === null) return recordValue == null;',
    "    if (typeof filterValue !== 'object' || Array.isArray(filterValue)) return recordValue === filterValue;",
    '    const op = filterValue as Record<string, unknown>;',
    "    if ('$ne' in op) return op['$ne'] === null ? recordValue != null : recordValue !== op['$ne'];",
    "    if ('$gt' in op) return compareFilterValues(recordValue, op['$gt']) > 0;",
    "    if ('$gte' in op) return compareFilterValues(recordValue, op['$gte']) >= 0;",
    "    if ('$lt' in op) return compareFilterValues(recordValue, op['$lt']) < 0;",
    "    if ('$lte' in op) return compareFilterValues(recordValue, op['$lte']) <= 0;",
    "    if ('$in' in op) return Array.isArray(op['$in']) && op['$in'].includes(recordValue);",
    "    if ('$nin' in op) return Array.isArray(op['$nin']) && !op['$nin'].includes(recordValue);",
    "    if ('$contains' in op) return String(recordValue ?? '').toLowerCase().includes(String(op['$contains'] ?? '').toLowerCase());",
    '    return recordValue === filterValue;',
    '  }',
    '',
    '  function matchesFilter(record: Record<string, unknown>, filter: Record<string, unknown>): boolean {',
    "    const andFilters = filter['$and'];",
    '    if (Array.isArray(andFilters) && !andFilters.every(part => matchesFilter(record, part as Record<string, unknown>))) return false;',
    "    const orFilters = filter['$or'];",
    '    if (Array.isArray(orFilters) && !orFilters.some(part => matchesFilter(record, part as Record<string, unknown>))) return false;',
    '    for (const [key, val] of Object.entries(filter)) {',
    '      if (val === undefined || key === "$and" || key === "$or") continue;',
    '      if (!matchesFilterValue(record[key], val)) return false;',
    '    }',
    '    return true;',
    '  }',
    '',
    '  function resolveListFilter(opts: Record<string, unknown> | undefined): Record<string, unknown> | undefined {',
    '    if (!opts) return undefined;',
    "    if (opts['filter'] && typeof opts['filter'] === 'object' && !Array.isArray(opts['filter'])) return opts['filter'] as Record<string, unknown>;",
    '    const filter: Record<string, unknown> = {};',
    '    for (const [key, value] of Object.entries(opts)) {',
    "      if (value === undefined || key === 'filter' || key === 'limit' || key === 'cursor' || key === 'sortDir' || key === 'includeDeleted') continue;",
    '      filter[key] = value;',
    '    }',
    '    return Object.keys(filter).length > 0 ? filter : undefined;',
    '  }',
    '',
  );
}

interface SqlFilterField {
  readonly name: string;
  readonly column: string;
  readonly type: string;
}

/** Append a parameterized dynamic filter compiler for a generated SQL adapter. */
export function appendRuntimeSqlFilterBuilder(
  lines: string[],
  dialect: 'postgres' | 'sqlite',
  fields: readonly SqlFilterField[],
): void {
  const placeholder =
    dialect === 'postgres'
      ? 'const placeholder = () => `$${nextIndex++}`;'
      : "const placeholder = () => '?';";
  const contains =
    dialect === 'postgres'
      ? "parts.push(`${meta.col} ILIKE ${placeholder()} ESCAPE '\\\\'`);"
      : "parts.push(`LOWER(CAST(${meta.col} AS TEXT)) LIKE LOWER(${placeholder()}) ESCAPE '\\\\'`);";
  const valueConversion =
    dialect === 'postgres'
      ? [
          "    if (type === 'json' || type === 'string[]') return JSON.stringify(value);",
          "    if (type === 'date' && value === 'now') return new Date();",
          "    if (type === 'date') return value instanceof Date ? value : new Date(String(value));",
        ]
      : [
          "    if (type === 'json' || type === 'string[]') return JSON.stringify(value);",
          "    if (type === 'date' && value === 'now') return Date.now();",
          "    if (type === 'date') return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();",
          "    if (type === 'boolean') return value ? 1 : 0;",
        ];

  lines.push(
    '  const listFilterFields: Record<string, { col: string; type: string }> = {',
    ...fields.map(
      field => `    '${field.name}': { col: '${field.column}', type: '${field.type}' },`,
    ),
    '  };',
    '',
    '  function resolveListFilter(opts: Record<string, unknown> | undefined): Record<string, unknown> | undefined {',
    '    if (!opts) return undefined;',
    "    if (opts['filter'] && typeof opts['filter'] === 'object' && !Array.isArray(opts['filter'])) return opts['filter'] as Record<string, unknown>;",
    '    const filter: Record<string, unknown> = {};',
    '    for (const [key, value] of Object.entries(opts)) {',
    "      if (value === undefined || key === 'filter' || key === 'limit' || key === 'cursor' || key === 'sortDir' || key === 'includeDeleted') continue;",
    '      filter[key] = value;',
    '    }',
    '    return Object.keys(filter).length > 0 ? filter : undefined;',
    '  }',
    '',
    '  function encodeListFilterValue(type: string, value: unknown): unknown {',
    ...valueConversion,
    '    return value;',
    '  }',
    '',
    '  function buildListFilterSql(filter: Record<string, unknown> | undefined, startIndex = 1): { sql: string; params: unknown[]; nextIndex: number } {',
    '    const params: unknown[] = [];',
    '    let nextIndex = startIndex;',
    `    ${placeholder}`,
    '    const compile = (expression: Record<string, unknown>): string => {',
    '      const parts: string[] = [];',
    '      for (const [key, value] of Object.entries(expression)) {',
    "        if (value === undefined || key === '$and' || key === '$or') continue;",
    '        const meta = listFilterFields[key];',
    '        if (!meta) continue;',
    '        if (value === null) { parts.push(`${meta.col} IS NULL`); continue; }',
    "        if (typeof value !== 'object' || Array.isArray(value)) {",
    '          parts.push(`${meta.col} = ${placeholder()}`);',
    '          params.push(encodeListFilterValue(meta.type, value));',
    '          continue;',
    '        }',
    '        const op = value as Record<string, unknown>;',
    "        if ('$ne' in op) {",
    "          if (op['$ne'] === null) parts.push(`${meta.col} IS NOT NULL`);",
    "          else { parts.push(`${meta.col} != ${placeholder()}`); params.push(encodeListFilterValue(meta.type, op['$ne'])); }",
    "        } else if ('$gt' in op || '$gte' in op || '$lt' in op || '$lte' in op) {",
    "          const operatorKey = ['$gt', '$gte', '$lt', '$lte'].find(candidate => candidate in op) as string;",
    "          const sqlOperator: Record<string, string> = { '$gt': '>', '$gte': '>=', '$lt': '<', '$lte': '<=' };",
    '          parts.push(`${meta.col} ${sqlOperator[operatorKey]} ${placeholder()}`);',
    '          params.push(encodeListFilterValue(meta.type, op[operatorKey]));',
    "        } else if ('$in' in op || '$nin' in op) {",
    "          const values = (('$in' in op ? op['$in'] : op['$nin']) as unknown[] | undefined) ?? [];",
    "          const negated = '$nin' in op;",
    "          if (values.length === 0) parts.push(negated ? 'TRUE' : 'FALSE');",
    '          else {',
    '            const placeholders = values.map(value => { params.push(encodeListFilterValue(meta.type, value)); return placeholder(); });',
    "            parts.push(`${meta.col} ${negated ? 'NOT IN' : 'IN'} (${placeholders.join(', ')})`);",
    '          }',
    "        } else if ('$contains' in op) {",
    `          ${contains}`,
    "          const escaped = String(op['$contains'] ?? '').replace(/[\\\\%_]/g, match => `\\\\${match}`);",
    '          params.push(`%${escaped}%`);',
    '        }',
    '      }',
    "      const andFilters = expression['$and'];",
    '      if (Array.isArray(andFilters)) {',
    '        const nested = andFilters.map(item => compile(item as Record<string, unknown>)).filter(Boolean);',
    "        if (nested.length > 0) parts.push(`(${nested.join(' AND ')})`);",
    '      }',
    "      const orFilters = expression['$or'];",
    '      if (Array.isArray(orFilters)) {',
    '        const nested = orFilters.map(item => compile(item as Record<string, unknown>)).filter(Boolean);',
    "        if (nested.length > 0) parts.push(`(${nested.join(' OR ')})`);",
    '      }',
    "      return parts.join(' AND ');",
    '    };',
    "    return { sql: filter ? compile(filter) : '', params, nextIndex };",
    '  }',
    '',
  );
}

/** Append a filter normalizer for generated Mongoose adapters. */
export function appendRuntimeMongoFilterBuilder(
  lines: string[],
  fields: readonly { name: string; primary: boolean }[],
): void {
  lines.push(
    `  const listFilterFieldNames = new Set([${fields.map(field => `'${field.name}'`).join(', ')}]);`,
    '',
    '  function resolveListFilter(opts: Record<string, unknown> | undefined): Record<string, unknown> | undefined {',
    '    if (!opts) return undefined;',
    "    if (opts['filter'] && typeof opts['filter'] === 'object' && !Array.isArray(opts['filter'])) return opts['filter'] as Record<string, unknown>;",
    '    const filter: Record<string, unknown> = {};',
    '    for (const [key, value] of Object.entries(opts)) {',
    "      if (value === undefined || key === 'filter' || key === 'limit' || key === 'cursor' || key === 'sortDir' || key === 'includeDeleted') continue;",
    '      filter[key] = value;',
    '    }',
    '    return Object.keys(filter).length > 0 ? filter : undefined;',
    '  }',
    '',
    '  function buildMongoListFilter(filter: Record<string, unknown> | undefined): Record<string, unknown> {',
    '    if (!filter) return {};',
    '    const query: Record<string, unknown> = {};',
    '    for (const [key, value] of Object.entries(filter)) {',
    "      if (key === '$and' || key === '$or') {",
    '        if (Array.isArray(value)) query[key] = value.map(part => buildMongoListFilter(part as Record<string, unknown>));',
    '        continue;',
    '      }',
    '      if (!listFilterFieldNames.has(key) || value === undefined) continue;',
    `      const mongoKey = key === '${fields.find(field => field.primary)?.name ?? 'id'}' ? '_id' : key;`,
    "      if (value && typeof value === 'object' && !Array.isArray(value) && '$contains' in (value as Record<string, unknown>)) {",
    "        const escaped = String((value as Record<string, unknown>)['$contains'] ?? '').replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
    "        query[mongoKey] = { $regex: escaped, $options: 'i' };",
    '      } else query[mongoKey] = value;',
    '    }',
    '    return query;',
    '  }',
    '',
  );
}
