/**
 * Manifest to Entity converter — bridges app-manifest entity definitions to
 * ResolvedEntityConfig + OperationConfig.
 *
 * The app manifest `entities` section is a record keyed by entity name, so
 * entities in that record don't carry a `name` field. This converter injects
 * the record key as `name` and routes through `resolveEntityManifest()`,
 * which calls `defineEntity()` and `defineOperations()` internally — so all
 * validation rules apply identically to JSON and TypeScript paths.
 */
import type { OperationConfig, ResolvedEntityConfig } from '../types';
import type { EntityHandlerRegistry } from './entityHandlerRegistry';
import type { ManifestEntities, ManifestEntity } from './entityManifestSchema';
import { manifestEntitiesSchema, manifestEntitySchema } from './entityManifestSchema';
import type { ResolvedManifest } from './resolveManifest';
import { resolveEntityManifest } from './resolveManifest';

// ---------------------------------------------------------------------------
// Single entity conversion
// ---------------------------------------------------------------------------

/**
 * The result of converting a single app-manifest entity to its resolved form.
 *
 * `operations` is present only when the manifest entity declared at least one
 * operation.
 *
 * @example
 * ```ts
 * import { manifestToEntity } from '@lastshotlabs/slingshot-entity';
 * import type { ManifestEntityResult } from '@lastshotlabs/slingshot-entity';
 *
 * const result: ManifestEntityResult = manifestToEntity('Message', {
 *   fields: { id: { type: 'string', primary: true, default: 'uuid' } },
 * });
 * console.log(result.config._storageName); // 'messages'
 * console.log(result.operations);          // undefined (no ops declared)
 * ```
 */
export interface ManifestEntityResult {
  config: ResolvedEntityConfig;
  operations?: Record<string, OperationConfig>;
}

/**
 * Convert a single app-manifest entity definition to `ResolvedEntityConfig` +
 * operations.
 *
 * The entity name comes from the record key in the app manifest's `entities`
 * section, so the manifest object itself does not include a `name` field. This
 * function injects the record key as `name` and routes through
 * `resolveEntityManifest()`, which calls `defineEntity()` and
 * `defineOperations()` — ensuring full validation parity with the TypeScript
 * builder API.
 *
 * @param name - The entity name (the record key from the app manifest's `entities` section).
 * @param manifest - The entity definition object (fields, indexes, operations, etc.)
 *   matching `ManifestEntity` (i.e. `entityManifestSchema` without the `name` field).
 * @param registry - Optional handler registry. Required when the manifest
 *   contains `custom` operations.
 * @returns A `ManifestEntityResult` with a frozen `config` and optional
 *   `operations` map.
 *
 * @throws {Error} When the manifest fails Zod schema validation.
 * @throws {Error} When a custom operation references an unregistered handler.
 * @throws {Error} When `defineEntity()` or `defineOperations()` validation fails.
 *
 * @example
 * ```ts
 * import { manifestToEntity } from '@lastshotlabs/slingshot-entity';
 *
 * const { config, operations } = manifestToEntity('Message', {
 *   fields: { id: { type: 'string', primary: true, default: 'uuid' }, body: { type: 'string' } },
 * });
 * ```
 */
export function manifestToEntity(
  name: string,
  manifest: ManifestEntity,
  registry?: EntityHandlerRegistry,
): ManifestEntityResult {
  // Validate input against the name-less entity schema (derived from the
  // canonical entityManifestSchema via .omit({ name: true })).
  const validated = manifestEntitySchema.parse(manifest);

  // Promote the record key into the `name` field expected by the canonical
  // resolver. Both schemas share every other field, so no cast is needed.
  const resolved: ResolvedManifest = resolveEntityManifest({ name, ...validated }, registry);

  return Object.keys(resolved.operations).length > 0
    ? { config: resolved.config, operations: resolved.operations }
    : { config: resolved.config };
}

// ---------------------------------------------------------------------------
// Multi-entity conversion
// ---------------------------------------------------------------------------

/**
 * The result of converting all entities in an app-manifest `entities` section.
 *
 * Keyed by the same names as the input `ManifestEntities` record.
 *
 * @example
 * ```ts
 * import { manifestEntitiesToConfigs } from '@lastshotlabs/slingshot-entity';
 * import type { ManifestEntitiesResult } from '@lastshotlabs/slingshot-entity';
 *
 * const result: ManifestEntitiesResult = manifestEntitiesToConfigs(appManifest.entities);
 * for (const [name, { config }] of Object.entries(result.entities)) {
 *   console.log(name, config._storageName);
 * }
 * ```
 */
export interface ManifestEntitiesResult {
  entities: Record<string, ManifestEntityResult>;
}

/**
 * Convert all entity definitions from an app-manifest `entities` section.
 *
 * Validates the entire `entities` record against `manifestEntitiesSchema`,
 * then resolves each entity independently via `manifestToEntity()`. Validation
 * errors from any entity are thrown immediately — no partial results are
 * returned.
 *
 * @param entities - The `entities` section of an app manifest (a record mapping
 *   entity names to `ManifestEntity` definitions).
 * @param registry - Optional handler registry. Required when any entity has
 *   `custom` operations.
 * @returns A `ManifestEntitiesResult` whose `entities` map matches the input
 *   keys.
 *
 * @throws {Error} When schema validation fails for any entity.
 * @throws {Error} When resolution fails for any entity.
 *
 * @example
 * ```ts
 * import { manifestEntitiesToConfigs } from '@lastshotlabs/slingshot-entity';
 *
 * const { entities } = manifestEntitiesToConfigs(appManifest.entities);
 * for (const [name, { config }] of Object.entries(entities)) {
 *   console.log(name, config._storageName);
 * }
 * ```
 */
export function manifestEntitiesToConfigs(
  entities: ManifestEntities,
  registry?: EntityHandlerRegistry,
): ManifestEntitiesResult {
  const validated = manifestEntitiesSchema.parse(entities);

  const result: Record<string, ManifestEntityResult> = {};
  for (const [name, entityDef] of Object.entries(validated)) {
    result[name] = manifestToEntity(name, entityDef, registry);
  }

  return { entities: result };
}
