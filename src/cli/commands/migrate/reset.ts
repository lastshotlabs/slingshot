import { Command, Flags } from '@oclif/core';
import { resolve } from 'path';
import { storageName } from '@lastshotlabs/slingshot-entity';
import { loadManifest, pickBackend, resolveConnectionString } from '../../lib/migrate/discover';
import { applyPending, dropAll } from '../../lib/migrate/runner';

export default class MigrateReset extends Command {
  static override description =
    'DESTRUCTIVE: drop every entity table from the configured database, drop the migration ' +
    'tracking table, and reapply every migration in order. All data is lost. Requires --force.';

  static override examples = [
    '<%= config.bin %> migrate reset --force',
    '<%= config.bin %> migrate reset --force --backend postgres',
  ];

  static override flags = {
    force: Flags.boolean({
      description: 'Required. Confirms you understand all data will be dropped.',
      default: false,
    }),
    config: Flags.string({
      char: 'c',
      description: 'Path to the app config file. Defaults to ./app.config.ts.',
    }),
    backend: Flags.string({
      description: 'Target backend. Auto-detected from app config db settings when omitted.',
      options: ['postgres', 'sqlite', 'mongo'],
    }),
    'db-url': Flags.string({
      description: 'Override connection string. Falls back to DATABASE_URL or app config.',
    }),
    'migrations-dir': Flags.string({
      description: 'Directory containing migration files.',
      default: 'migrations',
    }),
    'skip-apply': Flags.boolean({
      description: 'Drop tables but do not reapply migrations afterwards.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MigrateReset);

    if (!flags.force) {
      this.error('Refusing to reset without --force. This drops every entity table and all data.');
    }

    const manifest = await loadManifest(flags.config);
    const backend = pickBackend(manifest, flags.backend);
    const connectionString = resolveConnectionString(manifest, backend, flags['db-url']);
    const migrationsDir = resolve(flags['migrations-dir']);

    const tableNames = Object.values(manifest.entities).map(config => storageName(config, backend));

    let result;
    try {
      result = await dropAll({ backend, connectionString, tableNames });
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err));
    }
    this.log(`Dropped ${result.dropped.length} table(s):`);
    for (const name of result.dropped) {
      this.log(`  - ${name}`);
    }

    if (flags['skip-apply']) {
      this.log('');
      this.log('Skipped reapply (--skip-apply). Run `slingshot migrate apply` to recreate.');
      return;
    }

    let applied;
    try {
      applied = await applyPending({ backend, connectionString, migrationsDir });
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err));
    }
    this.log('');
    if (applied.applied.length === 0) {
      this.log('No migrations to apply. Database is empty.');
      return;
    }
    this.log(`Reapplied ${applied.applied.length} migration(s):`);
    for (const m of applied.applied) {
      this.log(`  ✓ ${m.id}`);
    }
  }
}
