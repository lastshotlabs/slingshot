import { Command, Flags } from '@oclif/core';
import { resolve } from 'path';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-entity';

export default class Fire extends Command {
  static override description =
    'Generate fake payloads from Zod schemas and optionally fire them as HTTP requests or event emissions. ' +
    'Useful for API smoke testing, event simulation, and payload prototyping.';

  static override examples = [
    '<%= config.bin %> fire --schema ./src/schemas/createUser.ts --count 5',
    '<%= config.bin %> fire --definition ./src/entities/index.ts --entity User --operation create --count 3',
    '<%= config.bin %> fire --schema ./src/schemas/createUser.ts --post http://localhost:3000/api/users',
    '<%= config.bin %> fire --schema ./src/schemas/createUser.ts --output ./payloads',
    '<%= config.bin %> fire --definition ./src/entities/index.ts --entity User --operation create --seed 42',
  ];

  static override flags = {
    schema: Flags.string({
      description:
        'Path to a TypeScript file exporting a Zod schema (default export or named "schema")',
      exclusive: ['definition'],
    }),
    definition: Flags.string({
      char: 'd',
      description:
        'Path to a TypeScript module exporting one or more ResolvedEntityConfig values from defineEntity()',
      exclusive: ['schema'],
    }),
    entity: Flags.string({
      char: 'e',
      description: 'Entity name (when using --definition)',
      dependsOn: ['definition'],
    }),
    operation: Flags.string({
      description: 'Which schema to generate from: create, update, entity, or list',
      default: 'create',
      options: ['create', 'update', 'entity', 'list'],
    }),
    count: Flags.integer({
      char: 'n',
      description: 'Number of payloads to generate',
      default: 1,
    }),
    seed: Flags.integer({
      char: 's',
      description: 'Deterministic seed for reproducible output',
    }),
    post: Flags.string({
      description: 'POST each generated payload to this URL',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Directory to write generated JSON payloads',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Fire);

    let schema: { _zod: { def: { type: string } } };
    let label: string;

    if (flags.definition) {
      // Generate from a TypeScript entity definition module
      const absPath = resolve(flags.definition);
      let entityModule: Record<string, unknown>;
      try {
        entityModule = (await import(absPath)) as Record<string, unknown>;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.error(`Failed to import entity definitions from '${absPath}': ${message}`);
      }

      const configs = findEntityConfigs(entityModule);
      if (configs.length === 0) {
        this.error(
          `No ResolvedEntityConfig export found in '${absPath}'. ` +
            `Ensure the file exports one or more values created by defineEntity().`,
        );
      }
      const available = configs.map(c => c.name).join(', ');

      if (!flags.entity) {
        this.error(`--entity is required when using --definition. Available: ${available}`);
      }

      const config = configs.find(c => c.name === flags.entity);
      if (!config) {
        this.error(`Entity "${flags.entity}" not found. Available: ${available}`);
      }

      const { generateSchemas } = await import('@lastshotlabs/slingshot-entity');
      const schemas = generateSchemas(config);
      const schemaMap: Record<string, { _zod: { def: { type: string } } }> = {
        create: schemas.createSchema,
        update: schemas.updateSchema,
        entity: schemas.entitySchema,
        list: schemas.listOptionsSchema,
      };

      schema = schemaMap[flags.operation];
      label = `${config.name}.${flags.operation}`;
    } else if (flags.schema) {
      // Import a raw Zod schema from a file
      const absPath = resolve(flags.schema);
      try {
        const mod = await import(absPath);
        schema = mod.default ?? mod.schema;
        if (!schema?._zod) {
          this.error(
            `File ${absPath} must export a Zod schema as the default export or as a named export "schema".`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.error(`Failed to import schema from '${absPath}': ${message}`);
      }
      label = flags.schema;
    } else {
      this.error('One of --schema or --definition is required.');
    }

    // Generate payloads — use generateMany which correctly seeds once
    const { generateMany } = await import('@lastshotlabs/slingshot-core/faker');
    const genOpts = flags.seed !== undefined ? { seed: flags.seed } : {};
    const payloads = generateMany(schema, flags.count, genOpts);

    // Output
    if (flags.post) {
      this.log(`Firing ${payloads.length} ${label} payloads to ${flags.post}...`);
      for (const [i, payload] of payloads.entries()) {
        try {
          const res = await fetch(flags.post, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          this.log(`  [${i + 1}] ${res.status} ${res.statusText}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log(`  [${i + 1}] ERROR: ${message}`);
        }
      }
      return;
    }

    if (flags.output) {
      const { mkdirSync, writeFileSync } = await import('fs');
      const outDir = resolve(flags.output);
      mkdirSync(outDir, { recursive: true });
      for (const [i, payload] of payloads.entries()) {
        const filePath = resolve(outDir, `${label.replace(/\./g, '-')}-${i + 1}.json`);
        writeFileSync(filePath, JSON.stringify(payload, null, 2));
        this.log(`Wrote ${filePath}`);
      }
      return;
    }

    // Default: print to stdout
    if (payloads.length === 1) {
      this.log(JSON.stringify(payloads[0], null, 2));
    } else {
      this.log(JSON.stringify(payloads, null, 2));
    }
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
