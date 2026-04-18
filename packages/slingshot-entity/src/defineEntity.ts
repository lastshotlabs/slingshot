/**
 * Entity definition entry point — dev-time only.
 *
 * Validates config using Zod schema, resolves PK and storage name.
 */
import type { EntityConfig, FieldDef, ResolvedEntityConfig } from './types';
import { entityConfigSchema } from './validation';

// Re-export types (consumers import from defineEntity or index)
export type {
  FieldType,
  FieldDef,
  FieldOptions,
  AutoDefault,
  IndexDef,
  RelationDef,
  SoftDeleteConfig,
  PaginationConfig,
  TenantConfig,
  EntityStorageHints,
  EntityTtlConfig,
  EntityConfig,
  ResolvedEntityConfig,
} from './types';

// Re-export builders
export { field } from './builders/field';
export { index, relation } from './builders/entityHelpers';

// ---------------------------------------------------------------------------
// defineEntity() — validates via Zod schema, resolves PK and storage name
// ---------------------------------------------------------------------------

/**
 * Declare an entity and validate its configuration.
 *
 * This is the primary entry point for defining an entity at dev time. It:
 * 1. Validates the config with Zod (field types, primary key constraints,
 *    cross-field references for indexes, softDelete, tenant, and routes).
 * 2. Derives `_pkField` (the field with `primary: true`).
 * 3. Derives `_storageName` from the entity name and optional namespace.
 * 4. Deep-freezes the result so consumers always receive immutable data
 *    (CLAUDE.md rule 12).
 *
 * @param name - PascalCase entity name used as the TypeScript type name and
 *   the basis for the storage name.
 * @param config - Entity configuration without the `name` field.
 * @returns A frozen `ResolvedEntityConfig` with `_pkField` and `_storageName`
 *   added.
 *
 * @throws {Error} When validation fails, with a structured message listing
 *   every issue and its field path.
 *
 * @example
 * ```ts
 * import { defineEntity, field, index } from '@lastshotlabs/slingshot-entity';
 *
 * export const Message = defineEntity('Message', {
 *   namespace: 'chat',
 *   fields: {
 *     id:        field.string({ primary: true, default: 'uuid' }),
 *     roomId:    field.string(),
 *     body:      field.string(),
 *     createdAt: field.date({ default: 'now' }),
 *   },
 *   indexes: [index(['roomId', 'createdAt'])],
 * });
 * // Message._pkField     === 'id'
 * // Message._storageName === 'chat_messages'
 * ```
 */
export function defineEntity<F extends Record<string, FieldDef>>(
  name: string,
  config: Omit<EntityConfig<F>, 'name'>,
): ResolvedEntityConfig<F> {
  // Validate using Zod schema — provides structured error messages with paths
  const fullConfig = { name, ...config };
  const result = entityConfigSchema.safeParse(fullConfig);

  if (!result.success) {
    const issues = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`[defineEntity:${name}] Validation failed:\n${issues}`);
  }

  // Resolve PK (already validated by schema — exactly one primary key exists)
  let pkField: string = '';
  for (const [fieldName, def] of Object.entries(config.fields)) {
    if (def.primary) {
      pkField = fieldName;
      break;
    }
  }

  const namespace = config.namespace;
  const snake = name
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
  const pluralName =
    snake.endsWith('y') && !/[aeiou]y$/.test(snake)
      ? snake.slice(0, -1) + 'ies'
      : snake.endsWith('s') ||
          snake.endsWith('x') ||
          snake.endsWith('z') ||
          snake.endsWith('sh') ||
          snake.endsWith('ch')
        ? snake + 'es'
        : snake + 's';
  const storageName = namespace ? `${namespace}_${pluralName}` : pluralName;

  const resolved: ResolvedEntityConfig<F> = {
    name,
    ...config,
    _pkField: pkField,
    _storageName: storageName,
  };
  deepFreezeEntity(resolved);
  return resolved;
}

/**
 * Deep-freeze a resolved entity config and all nested objects (Rule 12).
 * Mirrors the helper in slingshot-core so both defineEntity entry points
 * return immutable data to consumers.
 */
function deepFreezeEntity(obj: object): void {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreezeEntity(value as object);
    }
  }
}
