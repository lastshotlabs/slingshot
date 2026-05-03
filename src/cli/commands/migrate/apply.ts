import { Command, Flags } from '@oclif/core';
import { resolve } from 'path';
import { loadManifest, pickBackend, resolveConnectionString } from '../../lib/migrate/discover';
import { applyPending } from '../../lib/migrate/runner';

export default class MigrateApply extends Command {
  static override description =
    'Apply all pending migrations to the configured database. Idempotent — already-applied ' +
    'migrations are skipped, tracked in the `_slingshot_entity_migrations` table.';

  static override examples = [
    '<%= config.bin %> migrate apply',
    '<%= config.bin %> migrate apply --backend postgres --db-url postgres://localhost/myapp',
    'DATABASE_URL=postgres://... <%= config.bin %> migrate apply',
  ];

  static override flags = {
    config: Flags.string({
      char: 'c',
      description: 'Path to the app config file. Defaults to ./app.config.ts.',
    }),
    backend: Flags.string({
      description: 'Target backend. Auto-detected from app config db settings when omitted.',
      options: ['postgres', 'sqlite', 'mongo'],
    }),
    'db-url': Flags.string({
      description:
        'Override connection string (or sqlite path). Falls back to DATABASE_URL or app config.',
    }),
    'migrations-dir': Flags.string({
      description: 'Directory containing migration files.',
      default: 'migrations',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MigrateApply);

    const manifest = await loadManifest(flags.config);
    const backend = pickBackend(manifest, flags.backend);
    const connectionString = resolveConnectionString(manifest, backend, flags['db-url']);
    const migrationsDir = resolve(flags['migrations-dir']);

    let result;
    try {
      result = await applyPending({ backend, connectionString, migrationsDir });
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err));
    }

    if (result.applied.length === 0) {
      this.log('No pending migrations. Database is up to date.');
      return;
    }

    this.log(`Applied ${result.applied.length} migration(s):`);
    for (const m of result.applied) {
      this.log(`  ✓ ${m.id}`);
    }
  }
}
