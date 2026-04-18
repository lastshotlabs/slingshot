/**
 * Zod schema validation for entity and operation definitions.
 *
 * These schemas validate the structural correctness of configs.
 * Cross-field validation (e.g., "softDelete field must exist in fields")
 * uses Zod's .superRefine() for clear, composable error messages.
 */
import { z } from 'zod';
import { entityRouteConfigSchema } from '@lastshotlabs/slingshot-core';
import type { RouteOperationConfig } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Field definition schema
// ---------------------------------------------------------------------------

const fieldTypeSchema = z.enum([
  'string',
  'number',
  'integer',
  'boolean',
  'date',
  'enum',
  'json',
  'string[]',
]);

const fieldDefSchema = z.object({
  type: fieldTypeSchema,
  optional: z.boolean(),
  primary: z.boolean(),
  immutable: z.boolean(),
  default: z
    .union([
      z.literal('uuid'),
      z.literal('now'),
      z.literal('cuid'),
      z.string(),
      z.number(),
      z.boolean(),
    ])
    .optional(),
  onUpdate: z.literal('now').optional(),
  enumValues: z.array(z.string()).readonly().optional(),
});

// ---------------------------------------------------------------------------
// Search config schemas
// ---------------------------------------------------------------------------

const searchFieldConfigSchema = z.object({
  searchable: z.boolean().optional(),
  weight: z.number().optional(),
  filterable: z.boolean().optional(),
  sortable: z.boolean().optional(),
  facetable: z.boolean().optional(),
  displayed: z.boolean().optional(),
  noTypoTolerance: z.boolean().optional(),
});

const geoSearchConfigSchema = z.object({
  latField: z.string(),
  lngField: z.string(),
  autoFilter: z.boolean().optional(),
});

const entitySearchConfigSchema = z.object({
  provider: z.string().optional(),
  fields: z.record(z.string(), searchFieldConfigSchema),
  geo: geoSearchConfigSchema.optional(),
  syncMode: z.enum(['write-through', 'event-bus', 'manual']).optional(),
  transform: z.string().optional(),
  indexName: z.string().optional(),
  distinctField: z.string().optional(),
  tenantIsolation: z.enum(['filtered', 'index-per-tenant']).optional(),
  tenantField: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Entity config schema (with cross-field validation)
// ---------------------------------------------------------------------------

const indexDefSchema = z.object({
  fields: z.array(z.string()),
  direction: z.enum(['asc', 'desc']).optional(),
  unique: z.boolean().optional(),
});

const relationDefSchema = z.object({
  kind: z.enum(['belongsTo', 'hasMany', 'hasOne']),
  target: z.string(),
  foreignKey: z.string(),
  optional: z.boolean().optional(),
});

/**
 * Zod schema that validates a full `EntityConfig` object.
 *
 * Used internally by `defineEntity()` and `validateEntityConfig()`. Contains
 * cross-field refinements (e.g. exactly one primary key, referenced fields
 * must exist, auto-default type compatibility, route config consistency).
 *
 * @remarks
 * Consumers typically do not use this schema directly — prefer `validateEntityConfig()`
 * for programmatic validation and `defineEntity()` for build-time validation.
 * This export exists for tools that need the raw Zod schema (e.g. JSON Schema
 * generation, OpenAPI derivation).
 *
 * @example
 * ```ts
 * import { entityConfigSchema } from '@lastshotlabs/slingshot-entity';
 * import { zodToJsonSchema } from 'zod-to-json-schema';
 *
 * // Derive a JSON Schema for tooling or documentation:
 * const jsonSchema = zodToJsonSchema(entityConfigSchema, 'EntityConfig');
 * fs.writeFileSync('entity-config.schema.json', JSON.stringify(jsonSchema, null, 2));
 * ```
 */
export const entityConfigSchema = z
  .object({
    name: z.string().min(1),
    namespace: z.string().optional(),
    fields: z.record(z.string(), fieldDefSchema),
    indexes: z.array(indexDefSchema).optional(),
    uniques: z.array(z.object({ fields: z.array(z.string()) })).optional(),
    relations: z.record(z.string(), relationDefSchema).optional(),
    softDelete: z
      .union([
        z.object({ field: z.string(), value: z.string() }),
        z.object({ field: z.string(), strategy: z.literal('non-null') }),
      ])
      .optional(),
    defaultSort: z
      .object({
        field: z.string(),
        direction: z.enum(['asc', 'desc']),
      })
      .optional(),
    pagination: z
      .object({
        cursor: z.object({ fields: z.array(z.string()) }).optional(),
        defaultLimit: z.number().optional(),
        maxLimit: z.number().optional(),
      })
      .optional(),
    tenant: z.object({ field: z.string(), optional: z.boolean().optional() }).optional(),
    ttl: z.object({ defaultSeconds: z.number() }).optional(),
    storage: z
      .object({
        memory: z.object({ maxEntries: z.number() }).optional(),
        redis: z.object({ keyPrefix: z.string() }).optional(),
        sqlite: z.object({ tableName: z.string() }).optional(),
        postgres: z.object({ tableName: z.string() }).optional(),
        mongo: z.object({ collectionName: z.string() }).optional(),
      })
      .optional(),
    search: entitySearchConfigSchema.optional(),
    routes: entityRouteConfigSchema.optional(),
  })
  .superRefine((config, ctx) => {
    const fieldNames = Object.keys(config.fields);
    const fieldDefs = config.fields;

    // Exactly one primary key
    const pkFields = Object.entries(fieldDefs).filter(([, def]) => def.primary);
    if (pkFields.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'No primary key field defined',
        path: ['fields'],
      });
    } else if (pkFields.length > 1) {
      ctx.addIssue({
        code: 'custom',
        message: `Multiple primary key fields: ${pkFields.map(([n]) => n).join(', ')}`,
        path: ['fields'],
      });
    } else {
      const [pkName, pkDef] = pkFields[0];
      if (pkDef.type !== 'string' && pkDef.type !== 'number' && pkDef.type !== 'integer') {
        ctx.addIssue({
          code: 'custom',
          message: `Primary key '${pkName}' must be string, number, or integer — got '${pkDef.type}'`,
          path: ['fields', pkName, 'type'],
        });
      }
    }

    // softDelete field must exist
    if (config.softDelete && !fieldNames.includes(config.softDelete.field)) {
      ctx.addIssue({
        code: 'custom',
        message: `softDelete.field '${config.softDelete.field}' not found in fields`,
        path: ['softDelete', 'field'],
      });
    }

    // tenant field must exist
    if (config.tenant && !fieldNames.includes(config.tenant.field)) {
      ctx.addIssue({
        code: 'custom',
        message: `tenant.field '${config.tenant.field}' not found in fields`,
        path: ['tenant', 'field'],
      });
    }

    // dataScope.field entries must reference declared fields
    const rawScope = config.routes?.dataScope;
    if (rawScope) {
      const scopeArray = Array.isArray(rawScope) ? rawScope : [rawScope];
      for (let i = 0; i < scopeArray.length; i++) {
        const entry = scopeArray[i];
        if (!fieldNames.includes(entry.field)) {
          ctx.addIssue({
            code: 'custom',
            message: `routes.dataScope[${i}].field '${entry.field}' does not exist in fields`,
            path: ['routes', 'dataScope', i, 'field'],
          });
        }
      }
    }

    // Search config cross-field validation
    if (config.search) {
      // Search field keys must reference entity fields
      for (const fieldName of Object.keys(config.search.fields)) {
        if (!fieldNames.includes(fieldName)) {
          ctx.addIssue({
            code: 'custom',
            message: `search.fields['${fieldName}'] references unknown field`,
            path: ['search', 'fields', fieldName],
          });
        }
      }

      // Geo fields must exist and be numeric
      if (config.search.geo) {
        for (const geoKey of ['latField', 'lngField'] as const) {
          const geoFieldName = config.search.geo[geoKey];
          if (!fieldNames.includes(geoFieldName)) {
            ctx.addIssue({
              code: 'custom',
              message: `search.geo.${geoKey} '${geoFieldName}' not found in fields`,
              path: ['search', 'geo', geoKey],
            });
          } else if (fieldDefs[geoFieldName].type !== 'number') {
            ctx.addIssue({
              code: 'custom',
              message: `search.geo.${geoKey} '${geoFieldName}' must be type 'number', got '${fieldDefs[geoFieldName].type}'`,
              path: ['search', 'geo', geoKey],
            });
          }
        }
      }

      // Distinct field must exist
      if (config.search.distinctField && !fieldNames.includes(config.search.distinctField)) {
        ctx.addIssue({
          code: 'custom',
          message: `search.distinctField '${config.search.distinctField}' not found in fields`,
          path: ['search', 'distinctField'],
        });
      }

      // Tenant field must exist when tenantIsolation is set
      if (config.search.tenantIsolation && config.search.tenantField) {
        if (!fieldNames.includes(config.search.tenantField)) {
          ctx.addIssue({
            code: 'custom',
            message: `search.tenantField '${config.search.tenantField}' not found in fields`,
            path: ['search', 'tenantField'],
          });
        }
      }
    }

    // Index fields must exist
    if (config.indexes) {
      for (let i = 0; i < config.indexes.length; i++) {
        for (const f of config.indexes[i].fields) {
          if (!fieldNames.includes(f)) {
            ctx.addIssue({
              code: 'custom',
              message: `Index references unknown field '${f}'`,
              path: ['indexes', i, 'fields'],
            });
          }
        }
      }
    }

    // Unique fields must exist, and each constraint must have no duplicates
    if (config.uniques) {
      for (let i = 0; i < config.uniques.length; i++) {
        const seen = new Set<string>();
        for (const f of config.uniques[i].fields) {
          if (!fieldNames.includes(f)) {
            ctx.addIssue({
              code: 'custom',
              message: `Unique constraint references unknown field '${f}'`,
              path: ['uniques', i, 'fields'],
            });
          }
          if (seen.has(f)) {
            ctx.addIssue({
              code: 'custom',
              message: `Unique constraint has duplicate field '${f}'`,
              path: ['uniques', i, 'fields'],
            });
          }
          seen.add(f);
        }
      }
    }

    // defaultSort field must exist
    if (config.defaultSort) {
      if (!fieldNames.includes(config.defaultSort.field)) {
        ctx.addIssue({
          code: 'custom',
          message: `defaultSort.field '${config.defaultSort.field}' not found in fields`,
          path: ['defaultSort', 'field'],
        });
      }
    }

    // Pagination cursor fields must exist
    if (config.pagination?.cursor) {
      for (const f of config.pagination.cursor.fields) {
        if (!fieldNames.includes(f)) {
          ctx.addIssue({
            code: 'custom',
            message: `pagination.cursor references unknown field '${f}'`,
            path: ['pagination', 'cursor', 'fields'],
          });
        }
      }
    }

    // Auto-default type checks
    for (const [name, def] of Object.entries(fieldDefs)) {
      if ((def.default === 'uuid' || def.default === 'cuid') && def.type !== 'string') {
        ctx.addIssue({
          code: 'custom',
          message: `Field '${name}' has default '${def.default}' but type '${def.type}' — only string fields support UUID/CUID`,
          path: ['fields', name, 'default'],
        });
      }
      if (def.default === 'now' && def.type !== 'date') {
        ctx.addIssue({
          code: 'custom',
          message: `Field '${name}' has default 'now' but type '${def.type}' — only date fields support 'now'`,
          path: ['fields', name, 'default'],
        });
      }
      if (def.onUpdate === 'now' && def.type !== 'date') {
        ctx.addIssue({
          code: 'custom',
          message: `Field '${name}' has onUpdate 'now' but type '${def.type}' — only date fields support onUpdate`,
          path: ['fields', name, 'onUpdate'],
        });
      }
    }

    // Routes cross-field validation
    if (config.routes) {
      const rc = config.routes;
      const crudNames = ['create', 'get', 'list', 'update', 'delete', 'clear'];
      const FORBIDDEN_EVENT_PREFIXES = [
        'security.',
        'auth:',
        'community:delivery.',
        'push:',
        'app:',
      ];

      // Collect all op entries for cross-field checks
      const opEntries: [string, RouteOperationConfig | undefined][] = [
        ...(['create', 'get', 'list', 'update', 'delete'] as const).map(
          (op): [string, RouteOperationConfig | undefined] => [
            op,
            rc[op as keyof typeof rc] as RouteOperationConfig | undefined,
          ],
        ),
        ...(Object.entries(rc.operations ?? {}) as [string, RouteOperationConfig][]),
      ];

      for (const [op, opConfig] of opEntries) {
        if (!opConfig) continue;

        // ownerField must reference an entity field
        if (
          opConfig.permission?.ownerField &&
          !fieldNames.includes(opConfig.permission.ownerField)
        ) {
          ctx.addIssue({
            code: 'custom',
            message: `routes.${op}.permission.ownerField "${opConfig.permission.ownerField}" does not exist on entity`,
            path: ['routes', op, 'permission', 'ownerField'],
          });
        }

        // middleware names must be declared in routes.middleware
        for (const mwName of opConfig.middleware ?? []) {
          if (!rc.middleware?.[mwName]) {
            ctx.addIssue({
              code: 'custom',
              message: `routes.${op}.middleware "${mwName}" is not declared in routes.middleware`,
              path: ['routes', op, 'middleware'],
            });
          }
        }

        // event payload fields must exist on entity
        const evt = opConfig.event;
        if (typeof evt === 'object' && evt.payload) {
          for (const f of evt.payload) {
            if (!fieldNames.includes(f)) {
              ctx.addIssue({
                code: 'custom',
                message: `routes.${op}.event.payload field "${f}" does not exist on entity`,
                path: ['routes', op, 'event', 'payload'],
              });
            }
          }
        }
      }

      // clientSafeEvents must not use forbidden namespaces
      for (const key of rc.clientSafeEvents ?? []) {
        if (FORBIDDEN_EVENT_PREFIXES.some(p => key.startsWith(p))) {
          ctx.addIssue({
            code: 'custom',
            message: `clientSafeEvents "${key}" uses a forbidden namespace`,
            path: ['routes', 'clientSafeEvents'],
          });
        }
      }

      // disable entries must name valid CRUD ops or declared operations
      for (const disabledName of rc.disable ?? []) {
        if (
          !crudNames.includes(disabledName) &&
          !Object.keys(rc.operations ?? {}).includes(disabledName)
        ) {
          ctx.addIssue({
            code: 'custom',
            message: `routes.disable "${disabledName}" is not a valid CRUD or operation name`,
            path: ['routes', 'disable'],
          });
        }
      }
    }
  });

// ---------------------------------------------------------------------------
// Operation config schema (with field reference validation)
// ---------------------------------------------------------------------------

/**
 * Build a Zod validator for an operation record against a specific set of
 * entity field names.
 *
 * The returned schema validates that field references inside operation configs
 * (e.g. `transition.field`, `fieldUpdate.set`, `search.fields`) all point to
 * real fields on the entity.
 *
 * @param fieldNames - The field names from the entity being validated.
 * @returns A Zod schema that validates `Record<string, OperationConfig>`.
 *
 * @remarks
 * This factory is called once per `validateOperations()` invocation. If you
 * need to validate multiple operation records against the same entity, cache
 * the result of one call to avoid rebuilding the schema.
 *
 * @example
 * ```ts
 * import { createOperationValidator } from '@lastshotlabs/slingshot-entity';
 *
 * const validator = createOperationValidator(['id', 'status', 'userId']);
 * const result = validator.safeParse(rawOperations);
 * if (!result.success) console.error(result.error.issues);
 * ```
 */
export function createOperationValidator(fieldNames: readonly string[]) {
  return z.record(z.string(), z.object({ kind: z.string() }).loose()).superRefine((ops, ctx) => {
    for (const [opName, opConfig] of Object.entries(ops)) {
      const kind = opConfig.kind;

      switch (kind) {
        case 'transition':
          if (
            'field' in opConfig &&
            typeof opConfig.field === 'string' &&
            !fieldNames.includes(opConfig.field)
          ) {
            ctx.addIssue({
              code: 'custom',
              message: `transition.field '${opConfig.field}' not found in entity fields`,
              path: [opName, 'field'],
            });
          }
          break;

        case 'fieldUpdate':
          if ('set' in opConfig && Array.isArray(opConfig.set)) {
            for (const f of opConfig.set) {
              if (typeof f === 'string' && !fieldNames.includes(f)) {
                ctx.addIssue({
                  code: 'custom',
                  message: `fieldUpdate.set references unknown field '${f}'`,
                  path: [opName, 'set'],
                });
              }
            }
          }
          break;

        case 'search':
          if ('fields' in opConfig && Array.isArray(opConfig.fields)) {
            for (const f of opConfig.fields) {
              if (typeof f === 'string' && !fieldNames.includes(f)) {
                ctx.addIssue({
                  code: 'custom',
                  message: `search.fields references unknown field '${f}'`,
                  path: [opName, 'fields'],
                });
              }
            }
          }
          break;

        case 'upsert':
          if ('match' in opConfig && Array.isArray(opConfig.match)) {
            for (const f of opConfig.match) {
              if (typeof f === 'string' && !fieldNames.includes(f)) {
                ctx.addIssue({
                  code: 'custom',
                  message: `upsert.match references unknown field '${f}'`,
                  path: [opName, 'match'],
                });
              }
            }
          }
          if ('set' in opConfig && Array.isArray(opConfig.set)) {
            for (const f of opConfig.set) {
              if (typeof f === 'string' && !fieldNames.includes(f)) {
                ctx.addIssue({
                  code: 'custom',
                  message: `upsert.set references unknown field '${f}'`,
                  path: [opName, 'set'],
                });
              }
            }
          }
          break;

        case 'aggregate': {
          const groupByField =
            'groupBy' in opConfig
              ? typeof opConfig.groupBy === 'string'
                ? opConfig.groupBy
                : opConfig.groupBy &&
                    typeof opConfig.groupBy === 'object' &&
                    'field' in opConfig.groupBy
                  ? (opConfig.groupBy as { field: string }).field
                  : undefined
              : undefined;
          if (groupByField && !fieldNames.includes(groupByField)) {
            ctx.addIssue({
              code: 'custom',
              message: `aggregate.groupBy references unknown field '${groupByField}'`,
              path: [opName, 'groupBy'],
            });
          }
          break;
        }

        case 'collection':
          if (
            'parentKey' in opConfig &&
            typeof opConfig.parentKey === 'string' &&
            !fieldNames.includes(opConfig.parentKey)
          ) {
            ctx.addIssue({
              code: 'custom',
              message: `collection.parentKey '${opConfig.parentKey}' not found in entity fields`,
              path: [opName, 'parentKey'],
            });
          }
          if ('operations' in opConfig && Array.isArray(opConfig.operations)) {
            if (
              (opConfig.operations.includes('update') || opConfig.operations.includes('remove')) &&
              !opConfig.identifyBy
            ) {
              ctx.addIssue({
                code: 'custom',
                message: `collection needs 'identifyBy' when operations include 'update' or 'remove'`,
                path: [opName, 'identifyBy'],
              });
            }
          }
          break;

        case 'consume':
          if (
            'expiry' in opConfig &&
            typeof opConfig.expiry === 'object' &&
            opConfig.expiry !== null
          ) {
            const expiry = opConfig.expiry as { field?: string };
            if (expiry.field && !fieldNames.includes(expiry.field)) {
              ctx.addIssue({
                code: 'custom',
                message: `consume.expiry.field '${expiry.field}' not found in entity fields`,
                path: [opName, 'expiry', 'field'],
              });
            }
          }
          break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Validation functions
// ---------------------------------------------------------------------------

/**
 * The result of a validation call.
 *
 * When `success` is `false`, `errors` contains a `ZodError` with structured
 * issue paths that can be mapped to user-friendly messages.
 *
 * @example
 * ```ts
 * import { validateEntityConfig } from '@lastshotlabs/slingshot-entity';
 * import type { ValidationResult } from '@lastshotlabs/slingshot-entity';
 *
 * const result: ValidationResult = validateEntityConfig(raw);
 * if (!result.success) {
 *   for (const issue of result.errors!.issues) {
 *     console.error(`${issue.path.join('.')}: ${issue.message}`);
 *   }
 * }
 * ```
 */
export interface ValidationResult {
  success: boolean;
  /** Present only when `success` is `false`. */
  errors?: z.ZodError;
}

/**
 * Validate an arbitrary value as an entity config.
 *
 * Runs the same Zod schema used by `defineEntity()` without throwing on
 * failure. Useful for validating JSON blobs from external sources (CLI input,
 * manifest files, etc.) before passing them to `defineEntity()`.
 *
 * @param config - The raw value to validate (typically `unknown` JSON).
 * @returns A `ValidationResult` — `{ success: true }` or
 *   `{ success: false, errors: ZodError }`.
 *
 * @example
 * ```ts
 * import { validateEntityConfig } from '@lastshotlabs/slingshot-entity';
 *
 * const raw = JSON.parse(fs.readFileSync('entity.json', 'utf-8'));
 * const result = validateEntityConfig(raw);
 * if (!result.success) {
 *   for (const issue of result.errors!.issues) {
 *     console.error(`${issue.path.join('.')}: ${issue.message}`);
 *   }
 * }
 * ```
 */
export function validateEntityConfig(config: unknown): ValidationResult {
  const result = entityConfigSchema.safeParse(config);
  return result.success ? { success: true } : { success: false, errors: result.error };
}

/**
 * Validate an operations record against an entity's field names.
 *
 * Checks that field references inside operation configs (transition, fieldUpdate,
 * search, upsert, aggregate, collection, consume) all point to known entity
 * fields. Returns structured errors rather than throwing.
 *
 * @param operations - The raw operations record to validate.
 * @param fieldNames - Known field names from the entity (used for reference checks).
 * @returns A `ValidationResult` — `{ success: true }` or
 *   `{ success: false, errors: ZodError }`.
 *
 * @example
 * ```ts
 * import { validateOperations } from '@lastshotlabs/slingshot-entity';
 *
 * const result = validateOperations(rawOps, ['id', 'status', 'userId']);
 * if (!result.success) {
 *   console.error(result.errors?.message);
 * }
 * ```
 */
export function validateOperations(
  operations: unknown,
  fieldNames: readonly string[],
): ValidationResult {
  const validator = createOperationValidator(fieldNames);
  const result = validator.safeParse(operations);
  return result.success ? { success: true } : { success: false, errors: result.error };
}
