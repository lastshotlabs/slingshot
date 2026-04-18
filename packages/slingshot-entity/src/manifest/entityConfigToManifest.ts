import type {
  EntityChannelConfig,
  EntityRouteConfig,
  OperationConfig,
  ResolvedEntityConfig,
} from '@lastshotlabs/slingshot-core';
import type { FieldDef } from '../types/fields';
import type {
  ManifestEntity,
  ManifestField,
  ManifestOperation,
  RuntimeHookRef,
} from './entityManifestSchema';
import { manifestEntitySchema } from './entityManifestSchema';

/**
 * Overrides applied when converting code-defined entity configs into manifest entries.
 *
 * Use this when a package already has `defineEntity()` and `defineOperations()`
 * definitions but needs to export a real `MultiEntityManifest` without
 * hand-copying the declarative shape.
 */
export interface EntityManifestConversionOptions {
  /**
   * Named operations to convert alongside the entity config.
   *
   * When omitted, the manifest entry is emitted without an `operations` block.
   */
  readonly operations?: Readonly<Record<string, OperationConfig>>;
  /**
   * Per-operation overrides applied after the automatic conversion.
   *
   * Commonly used for `op.custom()` definitions that need a manifest handler
   * ref (for example `{ kind: 'custom', handler: 'chat.room.findOrCreateDm' }`).
   */
  readonly operationOverrides?: Readonly<Record<string, ManifestOperation>>;
  /**
   * Optional route-path override to emit on the manifest entry.
   */
  readonly routePath?: string;
  /**
   * Runtime adapter transforms to attach to the manifest entry.
   */
  readonly adapterTransforms?: readonly RuntimeHookRef[];
  /**
   * Optional channel config to attach to the manifest entry.
   *
   * This lets manifest-driven plugins preserve the same declarative WebSocket
   * channel wiring used by code-defined `EntityPluginEntry.channels`.
   */
  readonly channels?: EntityChannelConfig;
}

/**
 * Convert a resolved `FieldDef` into its manifest representation.
 *
 * @param field - Code-defined field config from `defineEntity()`.
 * @returns JSON-safe manifest field config.
 */
export function fieldDefToManifestField(field: FieldDef): ManifestField {
  return {
    type: field.type,
    optional: field.optional || undefined,
    primary: field.primary || undefined,
    immutable: field.immutable || undefined,
    format: field.format,
    default: field.default,
    onUpdate: field.onUpdate,
    values: field.type === 'enum' ? [...(field.enumValues ?? [])] : undefined,
  };
}

function cloneRouteConfig(
  routeConfig: EntityRouteConfig | undefined,
): EntityRouteConfig | undefined {
  if (!routeConfig) return undefined;
  return structuredClone(routeConfig);
}

function operationConfigToManifestOperation(operation: OperationConfig): ManifestOperation {
  switch (operation.kind) {
    case 'lookup':
    case 'exists':
    case 'transition':
    case 'fieldUpdate':
    case 'aggregate':
    case 'computedAggregate':
    case 'batch':
    case 'upsert':
    case 'search':
    case 'consume':
    case 'derive':
    case 'transaction':
    case 'pipe':
    case 'arrayPush':
    case 'arrayPull':
    case 'arraySet':
    case 'increment':
      return structuredClone(operation) as ManifestOperation;
    case 'collection':
      return {
        kind: 'collection',
        parentKey: operation.parentKey,
        itemFields: Object.fromEntries(
          Object.entries(operation.itemFields).map(([name, field]) => [
            name,
            fieldDefToManifestField(field),
          ]),
        ),
        operations: [...operation.operations],
        identifyBy: operation.identifyBy,
        maxItems: operation.maxItems,
      };
    case 'custom':
      return {
        kind: 'custom',
        http: operation.http
          ? {
              method: operation.http.method,
              path: operation.http.path,
            }
          : undefined,
      };
    default: {
      const exhaustiveCheck: never = operation;
      return exhaustiveCheck;
    }
  }
}

/**
 * Convert a named operations map into manifest operations.
 *
 * `op.custom()` definitions without an override become routing-only manifest
 * custom ops; supply `operationOverrides` when a runtime handler ref is
 * required.
 *
 * @param operations - Code-defined operation configs.
 * @param operationOverrides - Optional per-operation manifest overrides.
 * @returns JSON-safe manifest operation record.
 */
export function operationsToManifestOperations(
  operations: Readonly<Record<string, OperationConfig>>,
  operationOverrides?: Readonly<Record<string, ManifestOperation>>,
): Record<string, ManifestOperation> {
  const converted = Object.fromEntries(
    Object.entries(operations).map(([name, operation]) => [
      name,
      operationOverrides?.[name] ?? operationConfigToManifestOperation(operation),
    ]),
  );
  return converted;
}

/**
 * Convert a code-defined entity config into a manifest entry.
 *
 * This is intended for package-owned manifests that want to stay aligned with
 * existing `defineEntity()` / `defineOperations()` declarations while migrating
 * plugin bootstrap onto `createEntityPlugin({ manifest })`.
 *
 * @param config - Resolved entity config from `defineEntity()`.
 * @param options - Optional operation conversion and manifest-only overrides.
 * @returns A JSON-safe manifest entity entry suitable for `MultiEntityManifest.entities`.
 *
 * @example
 * ```ts
 * const messageEntry = entityConfigToManifestEntry(Message, {
 *   operations: messageOperations.operations,
 *   operationOverrides: {
 *     forwardMessage: {
 *       kind: 'custom',
 *       handler: 'chat.message.forward',
 *       http: { method: 'post' },
 *     },
 *   },
 *   adapterTransforms: [{ handler: 'chat.message.editedAt' }],
 * });
 * ```
 */
export function entityConfigToManifestEntry(
  config: ResolvedEntityConfig,
  options: EntityManifestConversionOptions = {},
): ManifestEntity {
  return manifestEntitySchema.parse({
    namespace: config.namespace,
    fields: Object.fromEntries(
      Object.entries(config.fields).map(([name, field]) => [name, fieldDefToManifestField(field)]),
    ),
    indexes: config.indexes
      ? config.indexes.map(index => ({ ...index, fields: [...index.fields] }))
      : undefined,
    uniques: config.uniques
      ? config.uniques.map(unique => ({ fields: [...unique.fields] }))
      : undefined,
    relations: config.relations ? structuredClone(config.relations) : undefined,
    softDelete: config.softDelete ? structuredClone(config.softDelete) : undefined,
    defaultSort: config.defaultSort ? structuredClone(config.defaultSort) : undefined,
    pagination: config.pagination
      ? {
          cursor: { fields: [...config.pagination.cursor.fields] },
          defaultLimit: config.pagination.defaultLimit,
          maxLimit: config.pagination.maxLimit,
        }
      : undefined,
    tenant: config.tenant ? structuredClone(config.tenant) : undefined,
    ttl: config.ttl ? structuredClone(config.ttl) : undefined,
    storage: config.storage ? structuredClone(config.storage) : undefined,
    operations: options.operations
      ? operationsToManifestOperations(options.operations, options.operationOverrides)
      : undefined,
    routes: cloneRouteConfig(config.routes),
    channels: options.channels ? structuredClone(options.channels) : undefined,
    routePath: options.routePath,
    adapterTransforms: options.adapterTransforms ? [...options.adapterTransforms] : undefined,
  });
}
