import { resolve } from 'node:path';
import { Command, Flags } from '@oclif/core';
import { loadManifest, pickBackend, resolveConnectionString } from '../../lib/migrate/discover';
import { buildMigrationPlanV2, verifyMigrationPlanV2 } from '../../lib/migrate/planV2';
import { getStatus } from '../../lib/migrate/runner';

export default class MigrateVerify extends Command {
  static override description =
    'Verify migration history, checksums, ordering, and v2 plan invariants without applying.';

  static override flags = {
    config: Flags.string({ char: 'c', description: 'Path to the app config file.' }),
    backend: Flags.string({ options: ['postgres', 'sqlite', 'mongo'] }),
    'db-url': Flags.string({ description: 'Override the configured database connection.' }),
    'migrations-dir': Flags.string({ default: 'migrations' }),
    json: Flags.boolean({ description: 'Print versioned deterministic JSON.', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MigrateVerify);
    const manifest = await loadManifest(flags.config);
    const backend = pickBackend(manifest, flags.backend);
    const status = await getStatus({
      backend,
      connectionString: resolveConnectionString(manifest, backend, flags['db-url']),
      migrationsDir: resolve(flags['migrations-dir']),
    });
    const plan = buildMigrationPlanV2(backend, status);
    const failures = verifyMigrationPlanV2(plan, status);
    const result = { formatVersion: 2, ok: failures.length === 0, failures, plan };
    if (flags.json) this.log(JSON.stringify(result, null, 2));
    else if (result.ok) this.log(`Migration verification passed (${plan.steps.length} step(s)).`);
    else
      this.error(
        `Migration verification failed:\n${failures.map(item => `  - ${item}`).join('\n')}`,
      );
  }
}
