/**
 * Multi-Entity Manifest — defines multiple entities for a plugin.
 *
 * This is the top-level manifest format. Each entity can have its own
 * fields, indexes, and operations. The resolved output feeds directly
 * into createCompositeFactories().
 */
import { z } from 'zod';
import type { OperationConfig, ResolvedEntityConfig } from '../types';
import type { EntityHandlerRegistry } from './entityHandlerRegistry';
import {
  manifestEntitySchema,
  manifestHooksSchema,
  pipeOpSchema,
  transactionOpSchema,
} from './entityManifestSchema';
import { resolveEntityManifest } from './resolveManifest';

// Entities inside a MultiEntityManifest may optionally declare their own
// `name` to override the record key. When omitted, the key is the entity name.
const multiEntityEntrySchema = manifestEntitySchema.extend({ name: z.string().optional() });

// ---------------------------------------------------------------------------
// Composite entry schema
// ---------------------------------------------------------------------------

const manifestCompositeEntrySchema = z.object({
  entities: z.tuple([z.string(), z.string()]).rest(z.string()),
  entityKey: z.string(),
  operations: z.record(z.string(), z.union([transactionOpSchema, pipeOpSchema])).optional(),
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for the top-level multi-entity manifest.
 *
 * Validates the `manifestVersion`, optional `namespace`, and the `entities`
 * record. Each entity is validated against `entityManifestSchema`.
 *
 * @example
 * ```ts
 * import { multiEntityManifestSchema } from '@lastshotlabs/slingshot-entity';
 *
 * const raw = JSON.parse(fs.readFileSync('plugin.manifest.json', 'utf-8'));
 * const result = multiEntityManifestSchema.safeParse(raw);
 * if (!result.success) {
 *   result.error.issues.forEach(i => console.error(`${i.path.join('.')}: ${i.message}`));
 * }
 * ```
 */
export const multiEntityManifestSchema = z
  .object({
    manifestVersion: z.number().int().min(1),
    namespace: z.string().optional(),
    hooks: manifestHooksSchema,
    // Each entity is keyed by its name. The optional `name` field overrides the
    // record key; when absent the key is used as the entity name.
    entities: z.record(z.string(), multiEntityEntrySchema),
    /**
     * Cross-entity composite groups. Each entry names two or more entities
     * from `entities` and declares any cross-entity operations. The `entityKey`
     * field identifies which entity's adapter is the primary one for route
     * mounting.
     */
    composites: z.record(z.string(), manifestCompositeEntrySchema).optional(),
  })
  .superRefine((data, ctx) => {
    for (const [compositeName, composite] of Object.entries(data.composites ?? {})) {
      for (const entityKey of composite.entities) {
        if (!(data.entities as Record<string, unknown>)[entityKey]) {
          ctx.addIssue({
            code: 'custom',
            path: ['composites', compositeName, 'entities'],
            message: `Composite '${compositeName}' references unknown entity '${entityKey}'`,
          });
        }
      }
      if (!composite.entities.includes(composite.entityKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['composites', compositeName, 'entityKey'],
          message: `entityKey '${composite.entityKey}' must be one of the listed entities`,
        });
      }
    }
  });

/**
 * A JSON-serializable manifest defining multiple entities for a plugin.
 *
 * The top-level `namespace` is applied to all entities that don't declare
 * their own. Pass to `resolveMultiEntityManifest()` or
 * `parseAndResolveMultiEntityManifest()` to obtain resolved configs.
 *
 * @example
 * ```json
 * {
 *   "manifestVersion": 1,
 *   "namespace": "billing",
 *   "entities": {
 *     "Invoice": { "fields": { "id": { "type": "string", "primary": true, "default": "uuid" } } }
 *   }
 * }
 * ```
 */
export type MultiEntityManifest = z.infer<typeof multiEntityManifestSchema>;

/**
 * A composite group within a `MultiEntityManifest`.
 *
 * Groups two or more entities from the manifest's `entities` map under a shared
 * `createCompositeFactories()` instance. Cross-entity operations (e.g.
 * `op.transaction` steps that reference multiple entities) are declared here.
 *
 * `entityKey` identifies which entity in the group this plugin entry represents —
 * its adapter is the one exposed to the entity plugin's route system.
 *
 * @example
 * ```json
 * {
 *   "entities": ["Document", "Snapshot"],
 *   "entityKey": "Document",
 *   "operations": {
 *     "revert": {
 *       "kind": "transaction",
 *       "steps": [
 *         { "op": "lookup",      "entity": "Snapshot", "match": { "id": "param:versionId" } },
 *         { "op": "fieldUpdate", "entity": "Document", "match": { "id": "param:id" },
 *           "set": { "title": "result:0.title" } }
 *       ]
 *     }
 *   }
 * }
 * ```
 */
export type ManifestCompositeEntry = z.infer<typeof manifestCompositeEntrySchema>;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The resolved output of `resolveMultiEntityManifest()`.
 *
 * Each key in `entities` matches a key in the original manifest and maps to
 * a `ResolvedManifest`-equivalent pair of `config` + `operations`.
 *
 * `composites` maps composite group names to their resolved entity keys,
 * `entityKey`, and resolved cross-entity `operations` (e.g. `op.transaction`).
 *
 * @example
 * ```ts
 * import { resolveMultiEntityManifest } from '@lastshotlabs/slingshot-entity';
 * import type { ResolvedMultiEntityManifest } from '@lastshotlabs/slingshot-entity';
 *
 * const resolved: ResolvedMultiEntityManifest = resolveMultiEntityManifest(myManifest);
 * for (const [name, { config, operations }] of Object.entries(resolved.entities)) {
 *   console.log(name, config._storageName, Object.keys(operations));
 * }
 * for (const [name, composite] of Object.entries(resolved.composites)) {
 *   console.log(name, composite.entityKey, Object.keys(composite.operations));
 * }
 * ```
 */
export interface ResolvedMultiEntityManifest {
  entities: Record<
    string,
    {
      config: ResolvedEntityConfig;
      operations: Record<string, OperationConfig>;
    }
  >;
  composites: Record<
    string,
    {
      entities: string[];
      entityKey: string;
      operations: Record<string, OperationConfig>;
    }
  >;
}

/**
 * Resolve a validated `MultiEntityManifest` into per-entity configs and
 * operations.
 *
 * Each entity is resolved independently via `resolveEntityManifest()`. The
 * top-level `namespace` is applied to entities that don't declare their own.
 * The returned structure maps directly to what `createCompositeFactories()`
 * expects.
 *
 * @param manifest - A validated `MultiEntityManifest`.
 * @param registry - Optional handler registry for `custom` operations.
 * @returns A `ResolvedMultiEntityManifest` mapping entity keys to their
 *   frozen configs and operations.
 *
 * @throws {Error} When any individual entity fails `defineEntity()` or
 *   `defineOperations()` validation.
 *
 * @example
 * ```ts
 * import { resolveMultiEntityManifest } from '@lastshotlabs/slingshot-entity';
 *
 * const resolved = resolveMultiEntityManifest(myManifest);
 * for (const [name, { config }] of Object.entries(resolved.entities)) {
 *   console.log(name, config._storageName);
 * }
 * ```
 */
export function resolveMultiEntityManifest(
  manifest: MultiEntityManifest,
  registry?: EntityHandlerRegistry,
): ResolvedMultiEntityManifest {
  const entities: ResolvedMultiEntityManifest['entities'] = {};

  for (const [key, entityManifest] of Object.entries(manifest.entities)) {
    // Entity `name` field overrides the record key; key is the fallback.
    const resolved = resolveEntityManifest(
      {
        ...entityManifest,
        name: entityManifest.name ?? key,
        namespace: entityManifest.namespace ?? manifest.namespace,
      },
      registry,
    );
    entities[key] = resolved;
  }

  // Resolve composite groups — transaction/pipe ops pass through as-is
  // (they are already valid OperationConfig values after Zod validation).
  const composites: ResolvedMultiEntityManifest['composites'] = {};
  for (const [name, composite] of Object.entries(manifest.composites ?? {})) {
    composites[name] = {
      entities: composite.entities,
      entityKey: composite.entityKey,
      operations: (composite.operations ?? {}) as Record<string, OperationConfig>,
    };
  }

  return { entities, composites };
}

/**
 * Validate raw JSON as a `MultiEntityManifest` and resolve it in one step.
 *
 * @param input - Raw value to validate and resolve (typically parsed JSON).
 * @param registry - Optional handler registry for `custom` operations.
 * @returns A fully resolved `ResolvedMultiEntityManifest`.
 *
 * @throws {Error} When the manifest fails Zod validation.
 * @throws {Error} When any entity fails `defineEntity()` or
 *   `defineOperations()` validation.
 *
 * @example
 * ```ts
 * import { parseAndResolveMultiEntityManifest } from '@lastshotlabs/slingshot-entity';
 *
 * const raw = JSON.parse(fs.readFileSync('plugin.manifest.json', 'utf-8'));
 * const { entities } = parseAndResolveMultiEntityManifest(raw, registry);
 * ```
 */
export function parseAndResolveMultiEntityManifest(
  input: unknown,
  registry?: EntityHandlerRegistry,
): ResolvedMultiEntityManifest {
  const result = multiEntityManifestSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`[multiEntityManifest] Invalid manifest: ${result.error.message}`);
  }
  return resolveMultiEntityManifest(result.data, registry);
}
