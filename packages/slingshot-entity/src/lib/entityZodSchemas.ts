/**
 * Runtime Zod schema builders derived from entity field definitions.
 *
 * Parallel to `generators/schemas.ts`, but returns live Zod schema objects
 * instead of source-code strings. Used by `buildBareEntityRoutes` to produce
 * typed OpenAPI response schemas for entity CRUD routes.
 */
import { z } from 'zod';
import type {
  EntityRouteDataScopeConfig,
  FieldDef,
  ResolvedEntityConfig,
} from '@lastshotlabs/slingshot-core';
import { registerSchema } from '@lastshotlabs/slingshot-core';
import { isAutoDefault } from './naming';

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Map a `FieldDef` to its runtime Zod schema.
 *
 * HTTP request and response bodies carry ISO-8601 strings for date fields.
 * The in-memory and DB adapters may use `Date` objects internally, but the
 * OpenAPI/Hono route boundary is JSON, so route schemas must validate the
 * serialized string representation.
 *
 * @param def - The field definition to map.
 * @param nullable - Whether the field should accept explicit `null`.
 * @returns A Zod schema matching the field's type and optionality.
 */
function fieldToZod(def: FieldDef, nullable = false): z.ZodType {
  let schema: z.ZodType;
  switch (def.type) {
    case 'string':
      schema = z.string();
      break;
    case 'number':
      schema = z.number();
      break;
    case 'integer':
      schema = z.number().int();
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    case 'date':
      schema = z.iso.datetime();
      break;
    case 'enum':
      if (def.enumValues && def.enumValues.length > 0) {
        schema = z.enum(def.enumValues as [string, ...string[]]);
      } else {
        schema = z.string();
      }
      break;
    case 'json':
      schema = z.unknown();
      break;
    case 'string[]':
      schema = z.array(z.string());
      break;
    default:
      schema = z.unknown();
  }
  const nullableSchema = nullable ? schema.nullable() : schema;
  return def.optional ? nullableSchema.optional() : nullableSchema;
}

/**
 * Map a field definition to a query-parameter-friendly Zod schema.
 *
 * Query params arrive as strings, so runtime route validation must coerce
 * numeric/date values and explicitly parse booleans before the adapter sees
 * them.
 */
function fieldToQueryZod(def: FieldDef): z.ZodType {
  switch (def.type) {
    case 'string':
      return z.string();
    case 'number':
      return z.coerce.number();
    case 'integer':
      return z.coerce.number().int();
    case 'boolean':
      return z.preprocess(value => {
        if (value === true || value === false) return value;
        if (value === 'true') return true;
        if (value === 'false') return false;
        return value;
      }, z.boolean());
    case 'date':
      return z.preprocess(value => {
        if (value instanceof Date) return value;
        if (typeof value === 'string' || typeof value === 'number') return new Date(value);
        return value;
      }, z.date());
    case 'enum':
      if (def.enumValues && def.enumValues.length > 0) {
        return z.enum(def.enumValues as [string, ...string[]]);
      }
      return z.string();
    case 'string[]':
      return z.preprocess(value => {
        if (isUnknownArray(value)) return value;
        if (typeof value === 'string') return [value];
        return value;
      }, z.array(z.string()));
    case 'json':
    default:
      return z.unknown();
  }
}

/**
 * Runtime Zod schemas derived from a `ResolvedEntityConfig`.
 *
 * - `entity` — full entity object schema (all fields).
 * - `create` — input schema for creation (excludes auto-defaults and `onUpdate` fields).
 * - `update` — partial update schema (all mutable, non-`onUpdate` fields as optional).
 * - `list` — list response schema with `items` array and optional pagination fields.
 * - `listOptions` — allowed list query params with runtime coercion.
 */
export interface EntityZodSchemas {
  /** Full entity object schema, registered in the OpenAPI component registry. */
  entity: z.ZodType;
  /** Create input schema. */
  create: z.ZodType;
  /** Update input schema. */
  update: z.ZodType;
  /** List response schema. */
  list: z.ZodType;
  /** List query schema. */
  listOptions: z.ZodObject;
}

/**
 * Build runtime Zod schemas from a `ResolvedEntityConfig` and register the
 * entity schema in the global OpenAPI component registry so it appears in the
 * generated spec as a named `$ref` component.
 *
 * @param config - The resolved entity configuration.
 * @returns `EntityZodSchemas` with `entity`, `create`, `update`, `list`, and `listOptions`.
 */
export function buildEntityZodSchemas(config: ResolvedEntityConfig): EntityZodSchemas {
  const fieldDefs = Object.entries(config.fields);

  // Optional belongsTo relations make the FK nullable at the HTTP boundary.
  const nullableFkFields = new Set<string>();
  if (config.relations) {
    for (const rel of Object.values(config.relations)) {
      if (rel.kind === 'belongsTo' && rel.optional) {
        nullableFkFields.add(rel.foreignKey);
      }
    }
  }

  // Collect fields that are server-injected via dataScope on create — these
  // must be optional in the create input schema because the client does not
  // (and should not) supply them; the route handler injects them from context.
  const dataScopeCreateFields = new Set<string>();
  const rawScope = config.routes?.dataScope;
  if (rawScope) {
    const scopes: readonly EntityRouteDataScopeConfig[] = Array.isArray(rawScope)
      ? rawScope
      : [rawScope as EntityRouteDataScopeConfig];
    for (const scope of scopes) {
      if (!scope.applyTo || scope.applyTo.includes('create')) {
        dataScopeCreateFields.add(scope.field);
      }
    }
  }

  // Full entity schema
  const entityShape: Record<string, z.ZodType> = {};
  for (const [fieldName, def] of fieldDefs) {
    const isNullable = nullableFkFields.has(fieldName) || def.optional;
    entityShape[fieldName] = fieldToZod(def, isNullable);
  }
  const entityRaw = z.object(entityShape);
  // Register so the schema appears as a named component in the OpenAPI spec
  const entity = registerSchema(config.name, entityRaw);

  // Create input schema (excludes auto-defaults, onUpdate fields, and
  // dataScope-injected fields which are marked optional)
  const createShape: Record<string, z.ZodType> = {};
  for (const [fieldName, def] of fieldDefs) {
    if (def.onUpdate === 'now') continue;
    if (isAutoDefault(def.default)) continue;
    const isNullable = nullableFkFields.has(fieldName) || def.optional;
    const hasLiteralDefault = def.default !== undefined && !isAutoDefault(def.default);
    const base = fieldToZod({ ...def, optional: false }, isNullable);
    const isInjected = dataScopeCreateFields.has(fieldName);
    createShape[fieldName] = isNullable || hasLiteralDefault || isInjected ? base.optional() : base;
  }
  const create = z.object(createShape);

  // Update input schema (all mutable, non-onUpdate fields as optional)
  const updateShape: Record<string, z.ZodType> = {};
  for (const [fieldName, def] of fieldDefs) {
    if (def.immutable) continue;
    if (def.onUpdate === 'now') continue;
    const isNullable = nullableFkFields.has(fieldName) || def.optional;
    const base = fieldToZod({ ...def, optional: false }, isNullable);
    updateShape[fieldName] = base.optional();
  }
  const update = z.object(updateShape);

  // List query schema
  const listOptionsShape: Record<string, z.ZodType> = {};
  const filterableFields = new Set<string>();

  for (const [fieldName, def] of fieldDefs) {
    if (def.type === 'enum' || def.type === 'boolean') {
      filterableFields.add(fieldName);
    }
  }

  if (config.indexes) {
    for (const idx of config.indexes) {
      for (const fieldName of idx.fields) {
        const def = config.fields[fieldName];
        if (def.type !== 'json') {
          filterableFields.add(fieldName);
        }
      }
    }
  }

  if (config.tenant) {
    filterableFields.add(config.tenant.field);
  }

  for (const fieldName of filterableFields) {
    const def = config.fields[fieldName];
    listOptionsShape[fieldName] = fieldToQueryZod(def).optional();
  }

  listOptionsShape['limit'] = z.coerce.number().int().positive().optional();
  listOptionsShape['cursor'] = z.string().optional();
  listOptionsShape['sortDir'] = z.enum(['asc', 'desc']).optional();
  const listOptions: z.ZodObject = z.object(listOptionsShape);

  // List response schema
  const list = z.object({
    items: z.array(entityRaw),
    cursor: z.string().optional(),
    nextCursor: z.string().optional(),
    hasMore: z.boolean().optional(),
  });

  return { entity, create, update, list, listOptions };
}
