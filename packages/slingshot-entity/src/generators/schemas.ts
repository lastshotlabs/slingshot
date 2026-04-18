/**
 * Generator: schemas.ts — Zod validation schemas. Imports only `zod`.
 */
import { fieldEntries, isAutoDefault } from '../lib/naming';
import type { FieldDef, ResolvedEntityConfig } from '../types';

/**
 * Map a `FieldDef` to its Zod type expression string.
 *
 * @param def - The field definition to map.
 * @returns A Zod expression string, e.g. `'z.string()'`, `'z.number().int()'`,
 *   `'z.enum(["a","b"])'`, `'z.coerce.date()'`.
 *
 * @remarks
 * Mapping strategy:
 * - `'string'` → `z.string()`
 * - `'number'` → `z.number()`
 * - `'integer'` → `z.number().int()`
 * - `'boolean'` → `z.boolean()`
 * - `'date'` → `z.coerce.date()` (accepts ISO strings from HTTP payloads)
 * - `'enum'` → `z.enum([...values])` when values are present, else `z.string()`
 * - `'json'` → `z.unknown()`
 * - `'string[]'` → `z.array(z.string())`
 * - Any unrecognised type → `z.unknown()`
 */
function zodTypeExpr(def: FieldDef): string {
  switch (def.type) {
    case 'string':
      return zodStringWithFormatExpr(def.format);
    case 'number':
      return 'z.number()';
    case 'integer':
      return 'z.number().int()';
    case 'boolean':
      return 'z.boolean()';
    case 'date':
      return 'z.coerce.date()';
    case 'enum':
      if (def.enumValues && def.enumValues.length > 0) {
        const vals = def.enumValues.map(v => `'${v}'`).join(', ');
        return `z.enum([${vals}])`;
      }
      return 'z.string()';
    case 'json':
      return 'z.unknown()';
    case 'string[]':
      return 'z.array(z.string())';
    default:
      return 'z.unknown()';
  }
}

function zodStringWithFormatExpr(format?: string): string {
  if (!format) return 'z.string()';

  switch (format) {
    case 'email':
      return "z.string().email().meta({ format: 'email' })";
    case 'url':
      return "z.string().url().meta({ format: 'url' })";
    case 'uuid':
      return "z.string().uuid().meta({ format: 'uuid' })";
    case 'cuid':
      return "z.string().cuid().meta({ format: 'cuid' })";
    case 'ulid':
      return "z.string().ulid().meta({ format: 'ulid' })";
    case 'date':
      return "z.string().date().meta({ format: 'date' })";
    case 'datetime':
      return "z.string().datetime().meta({ format: 'datetime' })";
    case 'time':
      return "z.string().time().meta({ format: 'time' })";
    case 'duration':
      return "z.string().duration().meta({ format: 'duration' })";
    case 'ipv4':
      return "z.string().ip({ version: 'v4' }).meta({ format: 'ipv4' })";
    case 'ipv6':
      return "z.string().ip({ version: 'v6' }).meta({ format: 'ipv6' })";
    case 'month':
      return "z.string().regex(/^\\d{4}-(0[1-9]|1[0-2])$/).meta({ format: 'month' })";
    case 'color':
      return "z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/).meta({ format: 'color' })";
    default:
      return `z.string().meta({ format: '${escapeSingleQuotes(format)}' })`;
  }
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Generate the Zod validation schema source code for an entity.
 *
 * Produces four named schema exports:
 * - `{camelName}Schema` — full entity object schema (all fields).
 * - `create{Name}Schema` — input schema for creation (excludes auto-defaults and
 *   `onUpdate` fields; fields with literal defaults are made optional).
 * - `update{Name}Schema` — partial update schema (all mutable, non-`onUpdate`
 *   fields as optional).
 * - `list{Name}OptionsSchema` — query-param schema for the list endpoint,
 *   including filterable enum/boolean/indexed fields plus `limit`, `cursor`, and
 *   `sortDir`.
 *
 * The generated file imports only `zod` and has no other dependencies.
 *
 * @param config - The resolved entity configuration containing field definitions,
 *   index definitions, and pagination config.
 * @returns A string containing the TypeScript source code for the schemas file.
 *
 * @remarks
 * - Enum fields map to `z.enum([...values])`. If no values are defined, they
 *   fall back to `z.string()`.
 * - `json` and unknown field types map to `z.unknown()`.
 * - Date fields use `z.coerce.date()` for automatic string-to-Date coercion.
 * - The list options schema includes all fields from `config.indexes` (excluding
 *   `json` type fields) plus any `config.tenant.field`.
 *
 * @example
 * ```ts
 * import { generateSchemas } from '@lastshotlabs/slingshot-entity';
 *
 * const source = generateSchemas(config);
 * // Write source to schemas.ts in the entity output directory
 * ```
 */
export function generateSchemas(config: ResolvedEntityConfig): string {
  const name = config.name;
  const fields = fieldEntries(config);

  // Build set of FK fields that are nullable via optional belongsTo relations
  const nullableFkFields = new Set<string>();
  if (config.relations) {
    for (const rel of Object.values(config.relations)) {
      if (rel.kind === 'belongsTo' && rel.optional) {
        nullableFkFields.add(rel.foreignKey);
      }
    }
  }

  const lines: string[] = [
    '// Auto-generated by @lastshotlabs/slingshot-entity — do not edit manually.',
    '',
    "import { z } from 'zod';",
    '',
  ];

  // --- Entity schema ---
  lines.push(`export const ${camel(name)}Schema = z.object({`);
  for (const [fieldName, def] of fields) {
    const base = zodTypeExpr(def);
    const isNullable = nullableFkFields.has(fieldName) || def.optional;
    const nullableBase = isNullable ? `${base}.nullable()` : base;
    const expr = isNullable ? `${nullableBase}.optional()` : nullableBase;
    lines.push(`  ${fieldName}: ${expr},`);
  }
  lines.push('});');
  lines.push('');

  // --- Create schema ---
  lines.push(`export const create${name}Schema = z.object({`);
  for (const [fieldName, def] of fields) {
    if (def.onUpdate === 'now') continue;
    if (isAutoDefault(def.default)) continue;
    const base = zodTypeExpr(def);
    const isNullable = nullableFkFields.has(fieldName) || def.optional;
    const createBase = isNullable ? `${base}.nullable()` : base;
    const hasLiteralDefault = def.default !== undefined && !isAutoDefault(def.default);
    const expr = isNullable || hasLiteralDefault ? `${createBase}.optional()` : createBase;
    lines.push(`  ${fieldName}: ${expr},`);
  }
  lines.push('});');
  lines.push('');

  // --- Update schema ---
  lines.push(`export const update${name}Schema = z.object({`);
  for (const [fieldName, def] of fields) {
    if (def.immutable) continue;
    if (def.onUpdate === 'now') continue;
    const base = zodTypeExpr(def);
    const isNullable = nullableFkFields.has(fieldName) || def.optional;
    const updateBase = isNullable ? `${base}.nullable()` : base;
    lines.push(`  ${fieldName}: ${updateBase}.optional(),`);
  }
  lines.push('});');
  lines.push('');

  // --- List options schema ---
  lines.push(`export const list${name}OptionsSchema = z.object({`);

  // Filterable fields: enums, booleans, indexed fields
  const filterableFields = new Set<string>();
  for (const [fieldName, def] of fields) {
    if (def.type === 'enum' || def.type === 'boolean') {
      filterableFields.add(fieldName);
    }
  }
  if (config.indexes) {
    for (const idx of config.indexes) {
      for (const f of idx.fields) {
        const fDef = (config.fields as Record<string, (typeof config.fields)[string] | undefined>)[
          f
        ];
        if (fDef && fDef.type !== 'json') {
          filterableFields.add(f);
        }
      }
    }
  }
  if (config.tenant) {
    filterableFields.add(config.tenant.field);
  }

  for (const fieldName of filterableFields) {
    const def = (config.fields as Record<string, (typeof config.fields)[string] | undefined>)[
      fieldName
    ];
    if (def) {
      lines.push(`  ${fieldName}: ${zodTypeExpr(def)}.optional(),`);
    }
  }

  lines.push(`  limit: z.number().int().positive().optional(),`);
  lines.push(`  cursor: z.string().optional(),`);
  lines.push(`  sortDir: z.enum(['asc', 'desc']).optional(),`);
  lines.push('});');
  lines.push('');

  return lines.join('\n');
}

/**
 * Lower-case the first character of a string.
 *
 * Used to turn a PascalCase entity name into a camelCase schema variable name.
 *
 * @param s - The string to convert (e.g. `'Message'`).
 * @returns The string with its first character lower-cased (e.g. `'message'`).
 *
 * @example
 * ```ts
 * camel('Message'); // 'message'
 * camel('UserProfile'); // 'userProfile'
 * ```
 */
function camel(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
