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
    '<%= config.bin %> migrate apply --include-framework',
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
    approve: Flags.string({
      description:
        'Exact approval digest printed by migrate plan for contract or destructive work.',
    }),
    'include-framework': Flags.boolean({
      description:
        'Apply framework-owned schemas, including PostgreSQL auth, after entity migrations.',
      default: false,
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
      result = await applyPending({
        backend,
        connectionString,
        migrationsDir,
        approve: flags.approve,
      });
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err));
    }

    let frameworkApplied = false;
    if (flags['include-framework']) {
      if (backend !== 'postgres') {
        this.error('--include-framework currently supports only the postgres backend.');
      }
      const postgresPkg = '@lastshotlabs/slingshot-postgres';
      const { connectPostgres, applyPostgresAuthSchema } = (await import(postgresPkg)) as {
        connectPostgres: (
          url: string,
          options: { migrations: 'assume-ready' },
        ) => Promise<{ pool: { end(): Promise<void> } }>;
        applyPostgresAuthSchema: (pool: unknown) => Promise<void>;
      };
      const postgres = await connectPostgres(connectionString, { migrations: 'assume-ready' });
      try {
        await applyPostgresAuthSchema(postgres.pool);
        frameworkApplied = true;
      } finally {
        await postgres.pool.end();
      }
    }

    if (result.applied.length === 0 && !frameworkApplied) {
      this.log('No pending migrations. Database is up to date.');
      return;
    }

    if (result.applied.length > 0) {
      this.log(`Applied ${result.applied.length} migration(s):`);
      for (const m of result.applied) {
        this.log(`  ✓ ${m.id}`);
      }
    }
    if (frameworkApplied) {
      this.log('✓ Framework-owned PostgreSQL schemas are up to date.');
    }
  }
}
