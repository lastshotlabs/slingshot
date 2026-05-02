import { Command, Flags } from '@oclif/core';
import { resolve } from 'path';
import { loadManifest, pickBackend } from '../../lib/migrate/discover';
import { planMigration, writeMigration } from '../../lib/migrate/planner';

export default class MigrateGenerate extends Command {
  static override description =
    'Generate a new migration file from the diff between current entity definitions and the last snapshot.';

  static override examples = [
    '<%= config.bin %> migrate generate --name init',
    '<%= config.bin %> migrate generate --name add_nickname --backend postgres',
    '<%= config.bin %> migrate generate --name init --config ./app.config.ts',
  ];

  static override flags = {
    name: Flags.string({
      char: 'n',
      description: 'Migration name (used in the filename, e.g. `add_nickname`).',
      required: true,
    }),
    config: Flags.string({
      char: 'c',
      description: 'Path to the app config file. Defaults to ./app.config.ts.',
    }),
    backend: Flags.string({
      description: 'Target backend. Auto-detected from app config db settings when omitted.',
      options: ['postgres', 'sqlite', 'mongo'],
    }),
    'snapshot-dir': Flags.string({
      description: 'Directory for entity snapshots.',
      default: '.slingshot/snapshots',
    }),
    'migrations-dir': Flags.string({
      description: 'Directory where migration files are written.',
      default: 'migrations',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MigrateGenerate);

    const manifest = await loadManifest(flags.config);
    if (Object.keys(manifest.entities).length === 0) {
      this.error(
        `No entities declared in ${manifest.manifestPath}. Add an entity plugin via ` +
          `createEntityPlugin({ entities: [...] }) or createEntityPlugin({ manifest: { entities: { ... } } }) before generating migrations.`,
      );
    }

    const backend = pickBackend(manifest, flags.backend);
    const snapshotDir = resolve(flags['snapshot-dir']);
    const migrationsDir = resolve(flags['migrations-dir']);

    const plan = planMigration({
      entities: manifest.entities,
      snapshotDir,
      migrationsDir,
      backend,
      name: flags.name,
    });

    if (!plan.sql.trim()) {
      this.log('No schema changes detected — nothing to generate.');
      return;
    }

    writeMigration({ plan, snapshotDir });

    this.log(`Generated ${plan.filename} (${backend})`);
    this.log(`  ${plan.path}`);
    this.log(
      `  ${plan.changedEntities.length} entit${plan.changedEntities.length === 1 ? 'y' : 'ies'}: ` +
        plan.changedEntities.map(c => c.name).join(', '),
    );
    this.log('');
    this.log('Next: review the file, then `slingshot migrate apply` to apply it.');
  }
}
