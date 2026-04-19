/**
 * Entity-aware seeder that generates and persists fake records via entity adapters.
 *
 * Sits on top of `generateFromSchema` (the universal Zod faker) and adds
 * entity-specific concerns: relation resolution, dependency ordering,
 * adapter-based persistence, and bulk operations.
 *
 * @example
 * ```ts
 * import { createEntitySeeder } from '@lastshotlabs/slingshot-entity/seeder';
 * import { generateSchemas } from '@lastshotlabs/slingshot-entity';
 *
 * const schemas = generateSchemas(userConfig);
 * const seeder = createEntitySeeder({
 *   config: userConfig,
 *   adapter: myAdapter,
 *   createSchema: schemas.createSchema,
 * });
 *
 * // Seed 20 users
 * const users = await seeder.seed(20);
 *
 * // Seed with overrides
 * const admins = await seeder.seed(5, { role: 'admin' });
 *
 * // Clean up
 * await seeder.clear();
 * ```
 *
 * @module
 */
import { generateFromSchema, type GenerateOptions } from '@lastshotlabs/slingshot-core/faker';
import { faker as defaultFaker } from '@faker-js/faker';
import type { ResolvedEntityConfig } from '../types/entity';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal adapter shape — anything with create() and clear(). */
export interface SeederAdapter<Entity = unknown, CreateInput = unknown> {
  create(input: CreateInput): Promise<Entity>;
  clear(): Promise<void>;
}

/** Any Zod schema that generateFromSchema can walk. */
type AnyZodSchema = { _zod: { def: { type: string } } };

export interface EntitySeederOptions<Entity, CreateInput> {
  /** The resolved entity config (for metadata: name, pkField, relations). */
  config: ResolvedEntityConfig;
  /** The adapter to persist records through. */
  adapter: SeederAdapter<Entity, CreateInput>;
  /** The Zod create schema for this entity (from generateSchemas). */
  createSchema: AnyZodSchema;
  /** Options forwarded to generateFromSchema. */
  generateOptions?: Omit<GenerateOptions, 'overrides'>;
}

export interface EntitySeeder<Entity = unknown> {
  /** The entity name. */
  readonly entityName: string;
  /** The primary key field name. */
  readonly pkField: string;
  /**
   * Generate and persist `count` records.
   * Returns the created entities (including server-assigned IDs).
   */
  seed(count: number, overrides?: Record<string, unknown>): Promise<Entity[]>;
  /** Generate and persist a single record. */
  seedOne(overrides?: Record<string, unknown>): Promise<Entity>;
  /** Delete all records via `adapter.clear()`. */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create an entity seeder bound to a specific adapter and create schema.
 */
export function createEntitySeeder<Entity = unknown, CreateInput = unknown>(
  options: EntitySeederOptions<Entity, CreateInput>,
): EntitySeeder<Entity> {
  const { config, adapter, createSchema, generateOptions } = options;

  return {
    entityName: config.name,
    pkField: config._pkField,

    async seed(count: number, overrides?: Record<string, unknown>): Promise<Entity[]> {
      // Resolve faker ONCE before the loop so we don't re-seed on every
      // iteration (which would produce identical records).
      const f = generateOptions?.faker ?? defaultFaker;
      if (generateOptions?.seed !== undefined) f.seed(generateOptions.seed);

      const results: Entity[] = [];
      for (let i = 0; i < count; i++) {
        const input = generateFromSchema<CreateInput>(createSchema, {
          ...generateOptions,
          seed: undefined,
          faker: f,
          overrides,
        });
        const entity = await adapter.create(input);
        results.push(entity);
      }
      return results;
    },

    async seedOne(overrides?: Record<string, unknown>): Promise<Entity> {
      const input = generateFromSchema<CreateInput>(createSchema, {
        ...generateOptions,
        overrides,
      });
      return adapter.create(input);
    },

    async clear(): Promise<void> {
      await adapter.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Multi-entity orchestrator
// ---------------------------------------------------------------------------

export interface MultiSeederEntry {
  config: ResolvedEntityConfig;
  adapter: SeederAdapter;
  createSchema: AnyZodSchema;
}

export interface MultiSeederOptions {
  /** Entity entries in any order — they'll be topo-sorted internally. */
  entities: MultiSeederEntry[];
  /** Options forwarded to all seeders. */
  generateOptions?: Omit<GenerateOptions, 'overrides'>;
}

export interface MultiSeederResult {
  /** Records indexed by entity name. */
  records: Map<string, unknown[]>;
  /** Clear all entities in reverse dependency order. */
  clearAll(): Promise<void>;
}

/**
 * Seed multiple entities in dependency order, automatically wiring
 * foreign keys from parent records.
 *
 * @example
 * ```ts
 * const result = await seedAll({
 *   entities: [
 *     { config: postConfig, adapter: postAdapter, createSchema: postCreateSchema },
 *     { config: userConfig, adapter: userAdapter, createSchema: userCreateSchema },
 *   ],
 * }, {
 *   User: { count: 10 },
 *   Post: { count: 50 },
 * });
 * ```
 */
export async function seedAll(
  options: MultiSeederOptions,
  plan: Record<string, { count: number; overrides?: Record<string, unknown> }>,
): Promise<MultiSeederResult> {
  // Lazy import to avoid circular dependency at module level
  const { topoSortEntities } = await import('./topoSort');

  const configs = options.entities.map((e) => e.config);
  const sorted = topoSortEntities(configs);

  const entryByName = new Map<string, MultiSeederEntry>();
  for (const entry of options.entities) {
    entryByName.set(entry.config.name, entry);
  }

  const records = new Map<string, unknown[]>();

  // Resolve faker ONCE before all entity loops to avoid re-seeding
  const { faker: fakerInstance } = await import('@faker-js/faker');
  const f = options.generateOptions?.faker ?? fakerInstance;
  if (options.generateOptions?.seed !== undefined) {
    f.seed(options.generateOptions.seed);
  }

  for (const config of sorted) {
    const entry = entryByName.get(config.name);
    if (!entry) continue;

    const entityPlan = plan[config.name];
    if (!entityPlan) continue;

    const seeded: unknown[] = [];

    for (let i = 0; i < entityPlan.count; i++) {
      const perRecordOverrides: Record<string, unknown> = { ...entityPlan.overrides };

      // Resolve FK references to random parent records
      if (config.relations) {
        for (const rel of Object.values(config.relations)) {
          if (rel.kind !== 'belongsTo') continue;
          if (rel.foreignKey in (entityPlan.overrides ?? {})) continue;

          const parentRecords = records.get(rel.target);
          if (parentRecords && parentRecords.length > 0) {
            const parent = f.helpers.arrayElement(parentRecords) as Record<string, unknown>;
            // Find the parent's PK field
            const parentEntry = entryByName.get(rel.target);
            if (parentEntry) {
              const pkField = parentEntry.config._pkField;
              perRecordOverrides[rel.foreignKey] = parent[pkField];
            }
          }
        }
      }

      // Call generateFromSchema directly instead of seeder.seedOne to avoid
      // re-seeding on every iteration — seedOne would pass generateOptions.seed
      // on every call, resetting the PRNG and producing near-identical records.
      const input = generateFromSchema(entry.createSchema, {
        ...options.generateOptions,
        seed: undefined,
        faker: f,
        overrides: perRecordOverrides,
      });
      const entity = await entry.adapter.create(input);
      seeded.push(entity);
    }

    records.set(config.name, seeded);
  }

  return {
    records,
    async clearAll() {
      // Clear in reverse dependency order (children first)
      const reversed = [...sorted].reverse();
      for (const config of reversed) {
        const entry = entryByName.get(config.name);
        if (entry) await entry.adapter.clear();
      }
    },
  };
}
