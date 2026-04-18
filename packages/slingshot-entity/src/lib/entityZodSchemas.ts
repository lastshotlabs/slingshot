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

/**
 * Map a `FieldDef` to its runtime Zod schema.
 *
 * HTTP request and response bodies carry ISO-8601 strings for date fields.
 * The in-memory and DB adapters may use `Date` objects internally, but the
 * OpenAPI/Hono route boundary is JSON, so route schemas must validate the
 * serialized string representation.
 *
 * @param def - The field definition to map.
 * @returns A Zod schema matching the field's type and optionality.
 */
function fieldToZod(def: FieldDef): z.ZodType {
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
  return def.optional ? schema.optional() : schema;
}

/**
 * Runtime Zod schemas derived from a `ResolvedEntityConfig`.
 *
 * - `entity` — full entity object schema (all fields).
 * - `create` — input schema for creation (excludes auto-defaults and `onUpdate` fields).
 * - `update` — partial update schema (all mutable, non-`onUpdate` fields as optional).
 * - `list` — list response schema with `items` array and optional pagination fields.
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
}

/**
 * Build runtime Zod schemas from a `ResolvedEntityConfig` and register the
 * entity schema in the global OpenAPI component registry so it appears in the
 * generated spec as a named `$ref` component.
 *
 * @param config - The resolved entity configuration.
 * @returns `EntityZodSchemas` with `entity`, `create`, `update`, and `list`.
 */
export function buildEntityZodSchemas(config: ResolvedEntityConfig): EntityZodSchemas {
  const fieldDefs = Object.entries(config.fields);

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
    entityShape[fieldName] = fieldToZod(def);
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
    const hasLiteralDefault = def.default !== undefined && !isAutoDefault(def.default);
    const base = fieldToZod({ ...def, optional: false });
    const isInjected = dataScopeCreateFields.has(fieldName);
    createShape[fieldName] =
      def.optional || hasLiteralDefault || isInjected ? base.optional() : base;
  }
  const create = z.object(createShape);

  // Update input schema (all mutable, non-onUpdate fields as optional)
  const updateShape: Record<string, z.ZodType> = {};
  for (const [fieldName, def] of fieldDefs) {
    if (def.immutable) continue;
    if (def.onUpdate === 'now') continue;
    const base = fieldToZod({ ...def, optional: false });
    updateShape[fieldName] = base.optional();
  }
  const update = z.object(updateShape);

  // List response schema
  const list = z.object({
    items: z.array(entityRaw),
    cursor: z.string().optional(),
    nextCursor: z.string().optional(),
    hasMore: z.boolean().optional(),
  });

  return { entity, create, update, list };
}
