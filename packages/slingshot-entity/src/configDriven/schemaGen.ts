/**
 * Zod schema generation from entity config.
 *
 * Derives four Zod schemas from a `ResolvedEntityConfig` at runtime, without any
 * code generation step. Schemas are consumed by route handlers for request validation
 * and by the REST API generator for OpenAPI type inference.
 *
 * **Generated schemas:**
 * 1. `entitySchema`      — Full record shape; optional fields become `.optional()`.
 * 2. `createSchema`      — Create input; excludes auto-default fields (`uuid`, `now`,
 *    `cuid`) and `onUpdate` fields. Fields with literal defaults or marked optional
 *    are optional in this schema.
 * 3. `updateSchema`      — Partial update input; all included fields are `.optional()`.
 *    Excludes immutable fields and `onUpdate` fields.
 * 4. `listOptionsSchema` — Filter + pagination options for list endpoints. Includes
 *    enum/boolean fields, all indexed fields, the tenant field, and `limit`/`cursor`/`sortDir`.
 *
 * @example
 * ```ts
 * const { entitySchema, createSchema, updateSchema } = generateSchemas(Message);
 * const parsed = createSchema.parse(req.body);
 * ```
 */
import { z } from 'zod';
import type { FieldDef, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { isAutoDefault } from './fieldUtils';

// ---------------------------------------------------------------------------
// Field type → Zod type mapping
// ---------------------------------------------------------------------------

/**
 * Map a single `FieldDef` to its base Zod type.
 *
 * - `string` → `z.string()`
 * - `number` → `z.number()`
 * - `integer` → `z.number().int()`
 * - `boolean` → `z.boolean()`
 * - `date` → `z.coerce.date()` (accepts ISO strings and timestamps)
 * - `enum` → `z.enum([...values])`, falling back to `z.string()` if no values defined
 * - `json` → `z.unknown()`
 * - `string[]` → `z.array(z.string())`
 * - unknown → `z.unknown()`
 *
 * Callers apply `.optional()` on top of this base type as needed.
 */
function zodTypeForField(def: FieldDef): z.ZodType {
  switch (def.type) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return def.type === 'integer' ? z.number().int() : z.number();
    case 'boolean':
      return z.boolean();
    case 'date':
      return z.coerce.date();
    case 'enum':
      if (!def.enumValues || def.enumValues.length === 0) {
        return z.string();
      }
      return z.enum(def.enumValues as [string, ...string[]]);
    case 'json':
      return z.unknown();
    case 'string[]':
      return z.array(z.string());
    default:
      return z.unknown();
  }
}

// ---------------------------------------------------------------------------
// Schema generators
// ---------------------------------------------------------------------------

/**
 * The four Zod schemas generated from a `ResolvedEntityConfig`.
 *
 * Each schema is a `z.ZodObject` so callers can merge, extend, or `.parse()` it.
 */
export interface GeneratedSchemas {
  /**
   * Full entity shape schema.
   * All fields present; fields marked `optional: true` in the entity config
   * become `.optional()` here.
   */
  entitySchema: z.ZodObject;
  /**
   * Create-operation input schema.
   * Excludes fields with auto-default values (`uuid`, `cuid`, `now`) and `onUpdate`
   * fields. Fields with literal defaults or marked optional are optional in this schema.
   */
  createSchema: z.ZodObject;
  /**
   * Update-operation input schema.
   * All included fields are `.optional()`. Excludes immutable fields and `onUpdate` fields.
   */
  updateSchema: z.ZodObject;
  /**
   * List-filter and pagination options schema.
   * Includes enum fields, boolean fields, indexed fields (non-JSON), the tenant field,
   * and the standard `limit`, `cursor`, and `sortDir` pagination params — all optional.
   */
  listOptionsSchema: z.ZodObject;
}

/**
 * Generate Zod validation schemas from a resolved entity config.
 *
 * All four schemas are derived in a single pass over `config.fields`, with additional
 * passes for `config.indexes`, `config.tenant`, and pagination defaults.
 * The function is pure — it has no side effects and can be called at any time.
 *
 * @param config - The resolved entity config produced by `defineEntity(...).config`.
 * @param inputVariant - Optional input-variant name. When provided, fields whose
 *   `inputVariants` array does not include this name are stripped from `createSchema`
 *   and `updateSchema`. Default behaviour (omit or pass `'default'`) excludes any
 *   field with a non-empty `inputVariants` allowlist. Variant-only fields (e.g.
 *   `role` gated to `'admin'`) appear in the generated schema only when the matching
 *   variant is requested.
 * @returns `GeneratedSchemas` containing `entitySchema`, `createSchema`, `updateSchema`,
 *          and `listOptionsSchema`.
 *
 * @example
 * ```ts
 * const { createSchema } = generateSchemas(Message);
 * const body = createSchema.parse(req.body); // throws ZodError on invalid input
 *
 * // Admin variant: includes role-gated fields
 * const { createSchema: adminCreate } = generateSchemas(User, 'admin');
 * ```
 */
export function generateSchemas(
  config: ResolvedEntityConfig,
  inputVariant?: string,
): GeneratedSchemas {
  const entityShape: Record<string, z.ZodType> = {};
  const createShape: Record<string, z.ZodType> = {};
  const updateShape: Record<string, z.ZodType> = {};
  const listShape: Record<string, z.ZodType> = {};

  // Build set of FK fields that are nullable via optional belongsTo relations
  const nullableFkFields = new Set<string>();
  if (config.relations) {
    for (const rel of Object.values(config.relations)) {
      if (rel.kind === 'belongsTo' && rel.optional) {
        nullableFkFields.add(rel.foreignKey);
      }
    }
  }

  // A field is settable by the requested input variant when:
  // - it has no `inputVariants` allowlist (always settable), OR
  // - the requested variant name appears in the allowlist.
  // Default behaviour (no variant requested) excludes any field with an allowlist.
  function isSettableByVariant(def: FieldDef): boolean {
    const allow = def.inputVariants;
    if (!allow || allow.length === 0) return true;
    if (!inputVariant) return false;
    return allow.includes(inputVariant);
  }

  for (const [name, def] of Object.entries(config.fields)) {
    const base = zodTypeForField(def);

    // A field is nullable if it's an optional belongsTo FK, or if the field
    // itself is optional — a field that can be absent should accept null on update.
    const isNullable = nullableFkFields.has(name) || def.optional;

    // --- Entity schema (responses): all fields except private ---
    if (!def.private) {
      const entityBase = isNullable ? base.nullable() : base;
      entityShape[name] = isNullable ? entityBase.optional() : entityBase;
    }

    // --- Create schema: exclude auto-default, onUpdate, and variant-gated fields ---
    const hasAuto = isAutoDefault(def.default);
    const hasOnUpdate = def.onUpdate === 'now';
    const settable = isSettableByVariant(def);

    if (!hasAuto && !hasOnUpdate && settable) {
      const hasLiteralDefault = def.default !== undefined && !isAutoDefault(def.default);
      const createBase = isNullable ? base.nullable() : base;
      if (isNullable || hasLiteralDefault) {
        createShape[name] = createBase.optional();
      } else {
        createShape[name] = createBase;
      }
    }

    // --- Update schema: exclude immutable, onUpdate, and variant-gated fields ---
    if (!def.immutable && !hasOnUpdate && settable) {
      const updateBase = isNullable ? base.nullable() : base;
      updateShape[name] = updateBase.optional();
    }

    // --- List filter options: enums, booleans, indexed string/number fields ---
    if (def.type === 'enum' || def.type === 'boolean') {
      listShape[name] = base.optional();
    }
  }

  // Add indexed fields to list options
  if (config.indexes) {
    for (const idx of config.indexes) {
      for (const fieldName of idx.fields) {
        if (!(fieldName in listShape)) {
          const def = config.fields[fieldName];
          if (def.type !== 'json') {
            listShape[fieldName] = zodTypeForField(def).optional();
          }
        }
      }
    }
  }

  // Add tenant field to list options
  if (config.tenant) {
    const tDef = config.fields[config.tenant.field];
    listShape[config.tenant.field] = zodTypeForField(tDef).optional();
  }

  // Pagination options
  listShape['limit'] = z.number().int().positive().optional();
  listShape['cursor'] = z.string().optional();
  listShape['sortDir'] = z.enum(['asc', 'desc']).optional();

  return {
    entitySchema: z.object(entityShape),
    createSchema: z.object(createShape),
    updateSchema: z.object(updateShape),
    listOptionsSchema: z.object(listShape),
  };
}
