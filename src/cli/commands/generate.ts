import { Command, Flags } from '@oclif/core';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { parseAndResolveMultiEntityManifest, writeGenerated } from '@lastshotlabs/slingshot-entity';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-entity';

export default class Generate extends Command {
  static override description =
    'Generate source files for entity definitions. Accepts a TypeScript definition file (--definition) or a JSON multi-entity manifest (--manifest).';

  static override examples = [
    '<%= config.bin %> generate --definition ./src/entities/message.ts --outdir ./src/generated/message',
    '<%= config.bin %> generate --definition ./src/entities/message.ts --outdir ./src/generated/message --migration',
    '<%= config.bin %> generate --manifest ./slingshot.entities.json --outdir ./src/generated',
    '<%= config.bin %> generate --manifest ./slingshot.entities.json --outdir ./src/generated --dry-run',
  ];

  static override flags = {
    definition: Flags.string({
      char: 'd',
      description: 'Path to the entity definition file (must export a ResolvedEntityConfig)',
      exclusive: ['manifest'],
    }),
    manifest: Flags.string({
      char: 'm',
      description:
        'Path to a JSON multi-entity manifest file. Each entity is generated into {outdir}/{entityName}.',
      exclusive: ['definition'],
    }),
    outdir: Flags.string({
      char: 'o',
      description: 'Output directory for generated files',
      required: true,
    }),
    migration: Flags.boolean({
      description: 'Generate migration scripts from snapshot diff',
      default: false,
    }),
    'snapshot-dir': Flags.string({
      description: 'Directory for entity snapshots',
      default: '.slingshot/snapshots',
    }),
    'dry-run': Flags.boolean({
      description: 'Preview generated files without writing to disk',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Generate);

    const snapshotDir = resolve(flags['snapshot-dir']);
    const migration = flags.migration;
    const dryRun = flags['dry-run'];
    const outDir = resolve(flags.outdir);

    if (flags.manifest) {
      this.runManifest(flags.manifest, { outDir, snapshotDir, migration, dryRun });
    } else if (flags.definition) {
      await this.runDefinition(flags.definition, { outDir, snapshotDir, migration, dryRun });
    } else {
      this.error('One of --definition or --manifest is required.');
    }
  }

  private runManifest(
    manifestPath: string,
    opts: { outDir: string; snapshotDir: string; migration: boolean; dryRun: boolean },
  ): void {
    const absPath = resolve(manifestPath);

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(absPath, 'utf-8'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error(`Failed to read manifest from '${absPath}': ${message}`);
    }

    let resolved: Awaited<ReturnType<typeof parseAndResolveMultiEntityManifest>>;
    try {
      resolved = parseAndResolveMultiEntityManifest(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error(`Invalid manifest: ${message}`);
    }

    for (const [entityName, { config, operations }] of Object.entries(resolved.entities)) {
      const entityOutDir = join(opts.outDir, entityName);
      const files = writeGenerated(config, {
        outDir: entityOutDir,
        dryRun: opts.dryRun,
        snapshotDir: opts.snapshotDir,
        migration: opts.migration,
        operations,
      });

      this.logEntityResult(entityName, entityOutDir, files, opts.dryRun, opts.migration);
    }
  }

  private async runDefinition(
    definitionPath: string,
    opts: { outDir: string; snapshotDir: string; migration: boolean; dryRun: boolean },
  ): Promise<void> {
    const absPath = resolve(definitionPath);

    let entityModule: Record<string, unknown>;
    try {
      entityModule = (await import(absPath)) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error(`Failed to import entity definition from '${absPath}': ${message}`);
    }

    const config = findEntityConfig(entityModule);
    if (!config) {
      this.error(
        `No ResolvedEntityConfig export found in '${absPath}'. ` +
          `Ensure the file exports a value created by defineEntity().`,
      );
    }

    const files = writeGenerated(config, {
      outDir: opts.outDir,
      dryRun: opts.dryRun,
      snapshotDir: opts.snapshotDir,
      migration: opts.migration,
    });

    this.logEntityResult(config.name, opts.outDir, files, opts.dryRun, opts.migration);
  }

  private logEntityResult(
    entityName: string,
    outDir: string,
    files: Record<string, string>,
    dryRun: boolean,
    migration: boolean,
  ): void {
    const migrationFiles = Object.keys(files).filter(f => f.startsWith('migrations/'));
    const sourceFiles = Object.keys(files).filter(f => !f.startsWith('migrations/'));

    if (dryRun) {
      this.log(`Generated files (dry run):`);
      for (const filename of Object.keys(files)) {
        this.log(`  ${filename}`);
      }
      return;
    }

    this.log(`${entityName}: generated ${sourceFiles.length} source file(s) in ${outDir}`);

    if (migrationFiles.length > 0) {
      this.log(`${entityName}: generated ${migrationFiles.length} migration file(s):`);
      for (const f of migrationFiles) {
        this.log(`  ${f}`);
      }
    } else if (migration) {
      this.log(`${entityName}: no schema changes detected — no migration files generated.`);
    }
  }
}

function findEntityConfig(mod: Record<string, unknown>): ResolvedEntityConfig | null {
  for (const value of Object.values(mod)) {
    if (isResolvedEntityConfig(value)) {
      return value;
    }
  }
  return null;
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
