import * as readline from 'node:readline';
import { Command, Flags } from '@oclif/core';
import {
  createRegistryFromConfig,
  destroyResources,
  loadPlatformConfig,
} from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class PlatformDestroy extends Command {
  static override description = 'Destroy provisioned resources for a stage';

  static override flags = {
    stage: Flags.string({ description: 'Stage to destroy', required: true }),
    resource: Flags.string({ description: 'Specific resource to destroy (default: all)' }),
    yes: Flags.boolean({ char: 'y', description: 'Skip confirmation prompt', default: false }),
  };

  async run() {
    const { flags } = await this.parse(PlatformDestroy);
    const { config: rawConfig } = await loadPlatformConfig();

    const config = resolvePlatformConfig(rawConfig, undefined);
    const stageName = flags.stage;

    if (!Object.hasOwn(config.stages, stageName)) {
      this.error(
        `Stage "${stageName}" not found. Available: ${Object.keys(config.stages).join(', ')}`,
      );
    }

    const resources = config.resources ?? {};
    const targetResources = flags.resource
      ? { [flags.resource]: resources[flags.resource] }
      : resources;

    if (flags.resource && !Object.hasOwn(resources, flags.resource)) {
      this.error(
        `Resource "${flags.resource}" not found. Available: ${Object.keys(resources).join(', ')}`,
      );
    }

    if (Object.keys(targetResources).length === 0) {
      this.log('No resources configured for this platform.');
      return;
    }

    this.log(`Resources to destroy for stage "${stageName}":`);
    for (const [name, rc] of Object.entries(targetResources)) {
      const stageOverride = rc.stages?.[stageName];
      const instanceClass = stageOverride?.instanceClass ?? '(default)';
      this.log(`  - ${name} (${instanceClass}, ${rc.type})`);
    }
    this.log('');

    if (!flags.yes) {
      const confirmed = await this.confirm('This action is irreversible. Proceed? (y/N) ');
      if (!confirmed) {
        this.log('Platform destroy cancelled.');
        return;
      }
    }

    const registry = createRegistryFromConfig(config.registry);

    const results = await destroyResources({
      platform: config,
      stageName,
      resource: flags.resource,
      registry,
    });

    for (const r of results) {
      if (r.status === 'destroyed') {
        this.log(`  \u2713 ${r.name}: destroyed`);
      } else if (r.status === 'skipped') {
        this.log(`  - ${r.name}: skipped${r.message ? ` (${r.message})` : ''}`);
      } else {
        this.log(`  \u2717 ${r.name}: error — ${r.message ?? 'unknown error'}`);
      }
    }

    this.log('\n\u2713 Platform destroy complete');
  }

  private confirm(message: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
      rl.question(message, answer => {
        rl.close();
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  }
}
