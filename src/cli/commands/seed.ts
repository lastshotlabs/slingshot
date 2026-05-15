import { Command, Flags } from '@oclif/core';
import { resolve } from 'path';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-entity';

export default class Seed extends Command {
  static override description =
    'Seed databases with realistic fake data generated from entity schemas. ' +
    'Imports a TypeScript module that exports one or more ResolvedEntityConfig values ' +
    'from defineEntity(), generates fake records using @faker-js/faker, and either ' +
    'writes JSON fixtures or prints to stdout. ' +
    'Note: distinct from `CreateAppConfig.seed`, which is the framework\'s idempotent ' +
    'boot-time seed phase used by packages like slingshot-auth, slingshot-permissions, ' +
    'and slingshot-organizations.';

  static override examples = [
    '<%= config.bin %> seed --definition ./src/entities/index.ts --count 20',
    '<%= config.bin %> seed --definition ./src/entities/index.ts --count 50 --seed 42',
    '<%= config.bin %> seed --definition ./src/entities/index.ts --entities User,Post --count 100',
    '<%= config.bin %> seed --definition ./src/entities/index.ts --count 10 --output ./fixtures',
  ];

  static override flags = {
    definition: Flags.string({
      char: 'd',
      description:
        'Path to a TypeScript module exporting one or more ResolvedEntityConfig values from defineEntity()',
      required: true,
    }),
    count: Flags.integer({
      char: 'n',
      description: 'Number of records to generate per entity',
      default: 10,
    }),
    entities: Flags.string({
      char: 'e',
      description: 'Comma-separated entity names to seed (default: all)',
    }),
    seed: Flags.integer({
      char: 's',
      description: 'Deterministic seed for reproducible output',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Directory to write generated JSON fixtures (instead of DB insert)',
    }),
    'dry-run': Flags.boolean({
      description: 'Preview generated data without persisting',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Seed);

    // -- Import entity definitions --
    const absPath = resolve(flags.definition);
    let entityModule: Record<string, unknown>;
    try {
      entityModule = (await import(absPath)) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error(`Failed to import entity definitions from '${absPath}': ${message}`);
    }

    let configs: ResolvedEntityConfig[] = findEntityConfigs(entityModule);
    if (configs.length === 0) {
      this.error(
        `No ResolvedEntityConfig export found in '${absPath}'. ` +
          `Ensure the file exports one or more values created by defineEntity().`,
      );
    }

    // -- Filter entities --
    if (flags.entities) {
      const selected = new Set(flags.entities.split(',').map(s => s.trim()));
      const unknown = [...selected].filter(n => !configs.some(c => c.name === n));
      if (unknown.length > 0) {
        this.error(
          `Unknown entities: ${unknown.join(', ')}. Available: ${configs.map(c => c.name).join(', ')}`,
        );
      }
      configs = configs.filter(c => selected.has(c.name));
    }

    // -- Generate data --
    const { generateFromSchema } = await import('@lastshotlabs/slingshot-core/faker');
    const { topoSortEntities } = await import('@lastshotlabs/slingshot-entity/seeder');

    const sorted = topoSortEntities(configs);
    const { generateSchemas } = await import('@lastshotlabs/slingshot-entity');

    const allRecords = new Map<string, unknown[]>();
    const { faker: fakerInstance } = await import('@faker-js/faker');

    // Seed faker ONCE before the loop — passing { seed } on every iteration
    // would re-seed to the same state and produce identical records.
    if (flags.seed !== undefined) {
      fakerInstance.seed(flags.seed);
    }

    for (const config of sorted) {
      const schemas = generateSchemas(config);
      const count = flags.count;

      this.log(`Generating ${count} ${config.name} records...`);

      const records: unknown[] = [];
      for (let i = 0; i < count; i++) {
        // Build FK overrides from already-seeded parent records
        const overrides: Record<string, unknown> = {};
        const relations = Object.values(config.relations ?? {});
        for (const rel of relations) {
          if (rel.kind !== 'belongsTo') continue;
          const parentRecords = allRecords.get(rel.target);
          if (parentRecords && parentRecords.length > 0) {
            const parentConfig = sorted.find(
              (candidate: ResolvedEntityConfig) => candidate.name === rel.target,
            );
            if (parentConfig) {
              const parent = fakerInstance.helpers.arrayElement(parentRecords) as Record<
                string,
                unknown
              >;
              overrides[rel.foreignKey] = parent[parentConfig._pkField];
            }
          }
        }

        const record = generateFromSchema(
          schemas.createSchema as { _zod: { def: { type: string } } },
          {
            faker: fakerInstance,
            overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
          },
        );
        records.push(record);
      }

      allRecords.set(config.name, records);
    }

    // -- Output --
    if (flags['dry-run']) {
      for (const [name, records] of allRecords) {
        this.log(`\n--- ${name} (${records.length} records) ---`);
        this.log(JSON.stringify(records.slice(0, 3), null, 2));
        if (records.length > 3) this.log(`  ... and ${records.length - 3} more`);
      }
      return;
    }

    if (flags.output) {
      const { mkdirSync, writeFileSync } = await import('fs');
      const outDir = resolve(flags.output);
      mkdirSync(outDir, { recursive: true });
      for (const [name, records] of allRecords) {
        const filePath = resolve(outDir, `${name}.json`);
        writeFileSync(filePath, JSON.stringify(records, null, 2));
        this.log(`Wrote ${records.length} ${name} records to ${filePath}`);
      }
      return;
    }

    // Without a live DB connection, output to stdout as JSON
    const output: Record<string, unknown[]> = {};
    for (const [name, records] of allRecords) {
      output[name] = records;
      this.log(`Generated ${records.length} ${name} records`);
    }
    this.log(JSON.stringify(output, null, 2));
  }
}

function findEntityConfigs(mod: Record<string, unknown>): ResolvedEntityConfig[] {
  const found: ResolvedEntityConfig[] = [];
  const seen = new Set<string>();
  for (const value of Object.values(mod)) {
    if (isResolvedEntityConfig(value) && !seen.has(value.name)) {
      seen.add(value.name);
      found.push(value);
    }
  }
  return found;
}

function isResolvedEntityConfig(value: unknown): value is ResolvedEntityConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['_pkField'] === 'string' &&
    typeof (value as Record<string, unknown>)['_storageName'] === 'string' &&
    typeof (value as Record<string, unknown>)['name'] === 'string' &&
    typeof (value as Record<string, unknown>)['fields'] === 'object'
  );
}
