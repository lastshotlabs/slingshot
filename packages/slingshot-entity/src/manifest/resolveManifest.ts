/**
 * Manifest Resolver — converts validated JSON manifest to ResolvedEntityConfig + operations.
 *
 * Routes through the canonical defineEntity() and defineOperations() entrypoints
 * so manifest JSON gets the same validation as the TypeScript builder API.
 */
import { defineEntity } from '../defineEntity';
import { defineOperations } from '../defineOperations';
import type {
  FieldDef,
  IndexDef,
  OperationConfig,
  RelationDef,
  ResolvedEntityConfig,
} from '../types';
import type { EntityHandlerRegistry } from './entityHandlerRegistry';
import type { EntityManifest, ManifestField, ManifestOperation } from './entityManifestSchema';
import { validateEntityManifest } from './entityManifestSchema';

// ---------------------------------------------------------------------------
// Field resolution — manifest format → FieldDef
// ---------------------------------------------------------------------------

function resolveField(manifest: ManifestField): FieldDef {
  const primary = manifest.primary ?? false;
  return {
    type: manifest.type,
    optional: manifest.optional ?? false,
    primary,
    // Mirror the TypeScript builder: primary keys default to immutable unless
    // the manifest explicitly opts out. See packages/slingshot-entity/src/builders/field.ts.
    immutable: manifest.immutable ?? primary,
    format: manifest.format,
    default: manifest.default,
    onUpdate: manifest.onUpdate,
    enumValues: manifest.values,
  };
}

// ---------------------------------------------------------------------------
// Operation resolution — manifest format → OperationConfig
// ---------------------------------------------------------------------------

function resolveOperation(
  opName: string,
  manifest: ManifestOperation,
  registry?: EntityHandlerRegistry,
): OperationConfig {
  if (manifest.kind === 'custom') {
    if (!manifest.handler) {
      // Routing-only marker — no backend implementation needed.
      const routingOnly: OperationConfig = { kind: 'custom', http: manifest.http };
      return routingOnly;
    }
    if (!registry) {
      throw new Error(
        `[resolveManifest] Custom operation '${opName}' requires a handler registry to resolve handler '${manifest.handler}'`,
      );
    }
    if (!registry.has(manifest.handler)) {
      throw new Error(
        `[resolveManifest] Custom operation '${opName}' references unknown handler '${manifest.handler}'. Available: [${registry.list().join(', ')}]`,
      );
    }
    // Resolve per-backend — each factory receives the backend driver at adapter construction
    const backends = registry.resolveForCustomOp(manifest.handler, manifest.params);
    return {
      kind: 'custom',
      http: manifest.http,
      memory: backends.memory,
      sqlite: backends.sqlite,
      mongo: backends.mongo,
      postgres: backends.postgres,
      redis: backends.redis,
    };
  }

  if (manifest.kind === 'collection') {
    // Collection itemFields need to be resolved from manifest format to FieldDef
    const itemFields: Record<string, FieldDef> = {};
    for (const [name, fieldManifest] of Object.entries(manifest.itemFields)) {
      itemFields[name] = resolveField(fieldManifest);
    }
    const collectionOp: OperationConfig = { ...manifest, itemFields };
    return collectionOp;
  }

  // All other ops are already structurally compatible — pass through
  return manifest as OperationConfig;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The resolved output of `resolveEntityManifest()`.
 *
 * Contains the frozen `ResolvedEntityConfig` and the validated operations map
 * ready to be passed to `generate()` or `createEntityPlugin()`.
 *
 * @example
 * ```ts
 * import { parseAndResolveEntityManifest } from '@lastshotlabs/slingshot-entity';
 * import type { ResolvedManifest } from '@lastshotlabs/slingshot-entity';
 *
 * const manifest: ResolvedManifest = parseAndResolveEntityManifest(JSON.parse(rawJson));
 * console.log(manifest.config._storageName);        // 'messages'
 * console.log(Object.keys(manifest.operations));    // ['byRoom', 'publish']
 * ```
 */
export interface ResolvedManifest {
  config: ResolvedEntityConfig;
  operations: Record<string, OperationConfig>;
}

/**
 * Resolve a validated `EntityManifest` into `ResolvedEntityConfig` + operations.
 *
 * Converts the manifest's field definitions, indexes, and operation configs into
 * the canonical TypeScript forms used by all downstream APIs. Routes through
 * `defineEntity()` and `defineOperations()` so all validation rules (field
 * references, primary key constraints, auto-default types) apply identically to
 * the JSON path and the TypeScript builder path.
 *
 * @param manifest - A validated `EntityManifest` (from `validateEntityManifest()`).
 * @param registry - Handler registry required when the manifest contains `custom`
 *   operations. Omit if no custom handlers are used.
 * @returns A `ResolvedManifest` with a frozen `config` and a frozen `operations` map.
 *
 * @throws {Error} When a `custom` operation names a handler not in the registry.
 * @throws {Error} When `defineEntity()` or `defineOperations()` validation fails.
 *
 * @example
 * ```ts
 * import { validateEntityManifest, resolveEntityManifest } from '@lastshotlabs/slingshot-entity';
 *
 * const raw = { name: 'Message', fields: { id: { type: 'string', primary: true, default: 'uuid' } } };
 * const { manifest } = validateEntityManifest(raw);
 * const { config, operations } = resolveEntityManifest(manifest!);
 * ```
 */
export function resolveEntityManifest(
  manifest: EntityManifest,
  registry?: EntityHandlerRegistry,
): ResolvedManifest {
  // Resolve fields from manifest format to FieldDef
  const fields: Record<string, FieldDef> = {};
  for (const [name, fieldManifest] of Object.entries(manifest.fields)) {
    fields[name] = resolveField(fieldManifest);
  }

  // Resolve indexes
  const indexes: IndexDef[] | undefined = manifest.indexes?.map(idx => ({
    fields: idx.fields,
    direction: idx.direction,
    unique: idx.unique,
  }));

  // Resolve relations
  const relations: Record<string, RelationDef> | undefined = manifest.relations
    ? Object.fromEntries(
        Object.entries(manifest.relations).map(([name, rel]) => [
          name,
          {
            kind: rel.kind,
            target: rel.target,
            foreignKey: rel.foreignKey,
            optional: rel.optional,
          },
        ]),
      )
    : undefined;

  // Call canonical defineEntity — gets all validation for free
  const config = defineEntity(manifest.name, {
    namespace: manifest.namespace,
    fields,
    indexes,
    uniques: manifest.uniques,
    relations,
    softDelete: manifest.softDelete,
    defaultSort: manifest.defaultSort as ResolvedEntityConfig['defaultSort'],
    pagination: manifest.pagination as ResolvedEntityConfig['pagination'],
    tenant: manifest.tenant,
    ttl: manifest.ttl,
    storage: manifest.storage,
    routes: manifest.routes as ResolvedEntityConfig['routes'],
  });

  // Resolve operations
  const ops: Record<string, OperationConfig> = {};
  if (manifest.operations) {
    for (const [opName, opManifest] of Object.entries(manifest.operations)) {
      ops[opName] = resolveOperation(opName, opManifest, registry);
    }
  }

  // Call canonical defineOperations — gets field reference validation for free.
  // defineOperations passes entityConfig through unchanged; we return config
  // directly to preserve the local ResolvedEntityConfig type from defineEntity().
  const operations: Record<string, OperationConfig> =
    Object.keys(ops).length > 0 ? defineOperations(config, ops).operations : {};

  return { config, operations };
}

/**
 * Validate raw JSON and resolve it into a `ResolvedManifest` in one step.
 *
 * Combines `validateEntityManifest()` + `resolveEntityManifest()`. Useful
 * when loading manifests from disk or the network where the input is
 * genuinely `unknown`.
 *
 * @param input - Raw value to validate and resolve.
 * @param registry - Optional handler registry for `custom` operations.
 * @returns A `ResolvedManifest` ready for use.
 *
 * @throws {Error} When validation fails, with a message from `ZodError`.
 * @throws {Error} When resolution fails (handler not found, field not found, etc.).
 *
 * @example
 * ```ts
 * import { parseAndResolveEntityManifest } from '@lastshotlabs/slingshot-entity';
 *
 * const { config } = parseAndResolveEntityManifest(JSON.parse(rawJson));
 * ```
 */
export function parseAndResolveEntityManifest(
  input: unknown,
  registry?: EntityHandlerRegistry,
): ResolvedManifest {
  const validation = validateEntityManifest(input);
  if (!validation.success || !validation.manifest) {
    throw new Error(
      `[resolveManifest] Invalid entity manifest: ${validation.errors?.message ?? 'unknown error'}`,
    );
  }
  return resolveEntityManifest(validation.manifest, registry);
}
