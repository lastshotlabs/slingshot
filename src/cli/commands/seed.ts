import { Command, Flags } from '@oclif/core';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseAndResolveMultiEntityManifest } from '@lastshotlabs/slingshot-entity';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-entity';

export default class Seed extends Command {
  static override description =
    'Seed databases with realistic fake data generated from entity schemas. ' +
    'Reads a JSON entity manifest, generates fake records using @faker-js/faker, ' +
    'and persists them via in-memory adapters or exports as JSON.';

  static override examples = [
    '<%= config.bin %> seed --manifest ./slingshot.entities.json --count 20',
    '<%= config.bin %> seed --manifest ./slingshot.entities.json --count 50 --seed 42',
    '<%= config.bin %> seed --manifest ./slingshot.entities.json --entities User,Post --count 100',
    '<%= config.bin %> seed --manifest ./slingshot.entities.json --count 10 --output ./fixtures',
    '<%= config.bin %> seed --manifest ./slingshot.entities.json --clean',
  ];

  static override flags = {
    manifest: Flags.string({
      char: 'm',
      description: 'Path to a JSON multi-entity manifest file',
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
    clean: Flags.boolean({
      description: 'Clear all entity data before seeding',
      default: false,
    }),
    'dry-run': Flags.boolean({
      description: 'Preview generated data without persisting',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Seed);

    // -- Parse manifest --
    const absPath = resolve(flags.manifest);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(absPath, 'utf-8'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error(`Failed to read manifest from '${absPath}': ${message}`);
    }

    let configs: ResolvedEntityConfig[];
    try {
      const result = parseAndResolveMultiEntityManifest(raw);
      configs = Object.values(result.entities).map(entry => entry.config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error(`Invalid entity manifest: ${message}`);
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
    const genOpts = flags.seed !== undefined ? { seed: flags.seed } : {};
    const { faker: fakerInstance } = await import('@faker-js/faker');

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

        const record = generateFromSchema(schemas.createSchema as any, {
          ...genOpts,
          overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
        });
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
