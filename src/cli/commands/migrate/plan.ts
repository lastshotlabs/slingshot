import { resolve } from 'node:path';
import { Command, Flags } from '@oclif/core';
import { loadManifest, pickBackend, resolveConnectionString } from '../../lib/migrate/discover';
import { buildMigrationPlanV2 } from '../../lib/migrate/planV2';
import { getStatus } from '../../lib/migrate/runner';

export default class MigratePlan extends Command {
  static override description =
    'Build a deterministic v2 migration plan with risk, locking, and verification details.';

  static override flags = {
    config: Flags.string({ char: 'c', description: 'Path to the app config file.' }),
    backend: Flags.string({ options: ['postgres', 'sqlite', 'mongo'] }),
    'db-url': Flags.string({ description: 'Override the configured database connection.' }),
    'migrations-dir': Flags.string({ default: 'migrations' }),
    json: Flags.boolean({ description: 'Print versioned deterministic JSON.', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MigratePlan);
    const manifest = await loadManifest(flags.config);
    const backend = pickBackend(manifest, flags.backend);
    const status = await getStatus({
      backend,
      connectionString: resolveConnectionString(manifest, backend, flags['db-url']),
      migrationsDir: resolve(flags['migrations-dir']),
    });
    const plan = buildMigrationPlanV2(backend, status);
    if (flags.json) {
      this.log(JSON.stringify(plan, null, 2));
      return;
    }
    this.log(`Migration plan v${plan.formatVersion}: ${plan.migrationId} (${backend})`);
    this.log(`Schema: ${plan.fromChecksum.slice(0, 12)} → ${plan.toChecksum.slice(0, 12)}`);
    for (const step of plan.steps) {
      this.log(
        `  ${step.id}  ${step.phase}/${step.risk}  lock=${step.lockRisk}  ${step.description}`,
      );
      for (const check of step.preconditions) this.log(`    pre: ${check.description}`);
      for (const check of step.verification) this.log(`    verify: ${check.description}`);
    }
    this.log(
      plan.approvalDigest
        ? `Approval required: --approve ${plan.approvalDigest}`
        : 'Approval required: no',
    );
  }
}
