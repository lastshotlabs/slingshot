import { Command, Flags } from '@oclif/core';
import { join, resolve } from 'path';
import { writeGenerated } from '@lastshotlabs/slingshot-entity';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-entity';

export default class Generate extends Command {
  static override description =
    'Generate source files for entity definitions. Accepts a TypeScript file that exports one or more ResolvedEntityConfig values (e.g. results of defineEntity()).';

  static override examples = [
    '<%= config.bin %> generate --definition ./src/entities/message.ts --outdir ./src/generated/message',
    '<%= config.bin %> generate --definition ./src/entities/message.ts --outdir ./src/generated/message --migration',
    '<%= config.bin %> generate --definition ./src/entities/index.ts --outdir ./src/generated --dry-run',
  ];

  static override flags = {
    definition: Flags.string({
      char: 'd',
      description:
        'Path to a TypeScript module exporting one or more ResolvedEntityConfig values from defineEntity()',
      required: true,
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

    await this.runDefinition(flags.definition, { outDir, snapshotDir, migration, dryRun });
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

    const configs = findEntityConfigs(entityModule);
    if (configs.length === 0) {
      this.error(
        `No ResolvedEntityConfig export found in '${absPath}'. ` +
          `Ensure the file exports one or more values created by defineEntity().`,
      );
    }

    if (configs.length === 1) {
      const [config] = configs;
      if (!config) return;
      const files = writeGenerated(config, {
        outDir: opts.outDir,
        dryRun: opts.dryRun,
        snapshotDir: opts.snapshotDir,
        migration: opts.migration,
      });
      this.logEntityResult(config.name, opts.outDir, files, opts.dryRun, opts.migration);
      return;
    }

    for (const config of configs) {
      const entityOutDir = join(opts.outDir, config.name);
      const files = writeGenerated(config, {
        outDir: entityOutDir,
        dryRun: opts.dryRun,
        snapshotDir: opts.snapshotDir,
        migration: opts.migration,
      });
      this.logEntityResult(config.name, entityOutDir, files, opts.dryRun, opts.migration);
    }
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
      this.log(`${entityName}: generated files (dry run):`);
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
