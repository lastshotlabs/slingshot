import { Command, Flags } from '@oclif/core';
import { resolve } from 'path';
import { loadManifest, pickBackend, resolveConnectionString } from '../../lib/migrate/discover';
import { getStatus } from '../../lib/migrate/runner';

export default class MigrateStatus extends Command {
  static override description =
    'Show which migrations have been applied to the configured database and which are pending. ' +
    'Also detects drift — applied migrations whose file content has changed since they ran.';

  static override examples = [
    '<%= config.bin %> migrate status',
    '<%= config.bin %> migrate status --backend postgres',
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
      description: 'Override connection string. Falls back to DATABASE_URL or app config.',
    }),
    'migrations-dir': Flags.string({
      description: 'Directory containing migration files.',
      default: 'migrations',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MigrateStatus);

    const manifest = await loadManifest(flags.config);
    const backend = pickBackend(manifest, flags.backend);
    const connectionString = resolveConnectionString(manifest, backend, flags['db-url']);
    const migrationsDir = resolve(flags['migrations-dir']);

    const status = await getStatus({ backend, connectionString, migrationsDir });

    this.log(`Backend: ${backend}`);
    this.log(`Migrations dir: ${migrationsDir}`);
    this.log('');

    if (status.applied.length === 0) {
      this.log('Applied: (none)');
    } else {
      this.log(`Applied (${status.applied.length}):`);
      for (const a of status.applied) {
        this.log(`  ✓ ${a.id}  (${a.appliedAt.toISOString()})`);
      }
    }
    this.log('');

    if (status.pending.length === 0) {
      this.log('Pending: (none)');
    } else {
      this.log(`Pending (${status.pending.length}):`);
      for (const p of status.pending) {
        this.log(`  · ${p.id}`);
      }
    }

    if (status.drift.length > 0) {
      this.log('');
      this.log(`DRIFT DETECTED (${status.drift.length}):`);
      for (const d of status.drift) {
        this.log(`  ! ${d.id}  (file modified after apply)`);
      }
      this.log(
        'Drift means an applied migration file has been edited. ' +
          'Restore the file or roll the change forward in a new migration.',
      );
    }

    if (status.missingFiles.length > 0) {
      this.log('');
      this.log(`MISSING FILES (${status.missingFiles.length}):`);
      for (const id of status.missingFiles) {
        this.log(`  ! ${id}  (applied but no file on disk)`);
      }
      this.log('Restore the missing files before applying new migrations.');
    }

    if (status.outOfOrder.length > 0) {
      this.log('');
      this.log(`OUT-OF-ORDER (${status.outOfOrder.length}):`);
      for (const id of status.outOfOrder) {
        this.log(`  ! ${id}  (sorts before latest applied)`);
      }
      this.log(
        'Rename these to use newer timestamps (or `migrate reset --force` in dev) ' +
          'before applying. Refusing to apply until resolved.',
      );
    }
  }
}
