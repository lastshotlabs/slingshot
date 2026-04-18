import { Command, Flags } from '@oclif/core';
import { readFileSync } from 'fs';
import { resolve } from 'path';

export default class Fire extends Command {
  static override description =
    'Generate fake payloads from Zod schemas and optionally fire them as HTTP requests or event emissions. ' +
    'Useful for API smoke testing, event simulation, and payload prototyping.';

  static override examples = [
    '<%= config.bin %> fire --schema ./src/schemas/createUser.ts --count 5',
    '<%= config.bin %> fire --manifest ./slingshot.entities.json --entity User --operation create --count 3',
    '<%= config.bin %> fire --schema ./src/schemas/createUser.ts --post http://localhost:3000/api/users',
    '<%= config.bin %> fire --schema ./src/schemas/createUser.ts --output ./payloads',
    '<%= config.bin %> fire --manifest ./slingshot.entities.json --entity User --operation create --seed 42',
  ];

  static override flags = {
    schema: Flags.string({
      description:
        'Path to a TypeScript file exporting a Zod schema (default export or named "schema")',
      exclusive: ['manifest'],
    }),
    manifest: Flags.string({
      char: 'm',
      description: 'Path to a JSON entity manifest file',
      exclusive: ['schema'],
    }),
    entity: Flags.string({
      char: 'e',
      description: 'Entity name (when using --manifest)',
      dependsOn: ['manifest'],
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

    const { generateFromSchema } = await import('@lastshotlabs/slingshot-core/faker');

    let schema: any;
    let label: string;

    if (flags.manifest) {
      // Generate from entity manifest
      const absPath = resolve(flags.manifest);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(absPath, 'utf-8'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.error(`Failed to read manifest: ${message}`);
      }

      const { parseAndResolveMultiEntityManifest, generateSchemas } =
        await import('@lastshotlabs/slingshot-entity');

      const resolved = parseAndResolveMultiEntityManifest(raw);
      const entries = Object.entries(resolved.entities).map(([key, entry]) => ({
        key,
        config: entry.config,
      }));
      const available = entries.map(({ config }) => config.name).join(', ');

      if (!flags.entity) {
        this.error(`--entity is required when using --manifest. Available: ${available}`);
      }

      const entry = entries.find(
        ({ key, config }) => key === flags.entity || config.name === flags.entity,
      );
      if (!entry) {
        this.error(`Entity "${flags.entity}" not found. Available: ${available}`);
      }

      const schemas = generateSchemas(entry.config);
      const schemaMap: Record<string, any> = {
        create: schemas.createSchema,
        update: schemas.updateSchema,
        entity: schemas.entitySchema,
        list: schemas.listOptionsSchema,
      };

      schema = schemaMap[flags.operation];
      label = `${entry.config.name}.${flags.operation}`;
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
      this.error('One of --schema or --manifest is required.');
    }

    // Generate payloads
    const genOpts = flags.seed !== undefined ? { seed: flags.seed } : {};
    const payloads: unknown[] = [];
    for (let i = 0; i < flags.count; i++) {
      payloads.push(generateFromSchema(schema, genOpts));
    }

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
