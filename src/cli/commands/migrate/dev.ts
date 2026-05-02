import { Command, Flags } from '@oclif/core';
import { resolve } from 'path';
import { loadManifest, pickBackend, resolveConnectionString } from '../../lib/migrate/discover';
import { planMigration, writeMigration } from '../../lib/migrate/planner';
import { applyPending } from '../../lib/migrate/runner';

export default class MigrateDev extends Command {
  static override description =
    'Generate a migration from the current entity definitions and apply it immediately. ' +
    'Equivalent to `migrate generate && migrate apply` — the everyday inner-loop command.';

  static override examples = [
    '<%= config.bin %> migrate dev --name init',
    '<%= config.bin %> migrate dev --name add_nickname',
  ];

  static override flags = {
    name: Flags.string({
      char: 'n',
      description: 'Migration name (used in the filename, e.g. `add_nickname`).',
      required: true,
    }),
    manifest: Flags.string({
      char: 'm',
      description: 'Path to the app manifest. Defaults to ./app.manifest.json.',
    }),
    backend: Flags.string({
      description: 'Target backend. Auto-detected from manifest db config when omitted.',
      options: ['postgres', 'sqlite', 'mongo'],
    }),
    'db-url': Flags.string({
      description: 'Override connection string. Falls back to DATABASE_URL or manifest.',
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
    const { flags } = await this.parse(MigrateDev);

    const manifest = loadManifest(flags.manifest);
    if (Object.keys(manifest.entities).length === 0) {
      this.error(
        `No entities declared in ${manifest.manifestPath}. Add an "entities" section ` +
          `to the manifest before running migrate dev.`,
      );
    }

    const backend = pickBackend(manifest, flags.backend);
    const connectionString = resolveConnectionString(manifest, backend, flags['db-url']);
    const snapshotDir = resolve(flags['snapshot-dir']);
    const migrationsDir = resolve(flags['migrations-dir']);

    const plan = planMigration({
      entities: manifest.entities,
      snapshotDir,
      migrationsDir,
      backend,
      name: flags.name,
    });

    if (plan.sql.trim()) {
      writeMigration({ plan, snapshotDir });
      this.log(`Generated ${plan.filename} (${backend})`);
    } else {
      this.log('No schema changes detected — skipping generate.');
    }

    let result;
    try {
      result = await applyPending({ backend, connectionString, migrationsDir });
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err));
    }

    if (result.applied.length === 0) {
      this.log('No pending migrations to apply. Database is up to date.');
      return;
    }

    this.log(`Applied ${result.applied.length} migration(s):`);
    for (const m of result.applied) {
      this.log(`  ✓ ${m.id}`);
    }
  }
}
