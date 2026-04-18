import * as readline from 'node:readline';
import { Args, Command, Flags } from '@oclif/core';
import { createRegistryFromConfig, loadPlatformConfig } from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class ServersRemove extends Command {
  static override description = 'Remove a stack/stage server entry from the registry';

  static override args = {
    stack: Args.string({ description: 'Stack name', required: true }),
  };

  static override flags = {
    stage: Flags.string({ description: 'Stage name', required: true }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip confirmation prompt',
      default: false,
    }),
    platform: Flags.string({ description: 'Target platform (for multi-platform configs)' }),
  };

  async run() {
    const { args, flags } = await this.parse(ServersRemove);
    const { config: rawConfig } = await loadPlatformConfig();
    const config = resolvePlatformConfig(rawConfig, flags.platform);
    const { stack: stackName, stage: stageName } = { stack: args.stack, stage: flags.stage };

    const registry = createRegistryFromConfig(config.registry);
    const lock = await registry.lock(120000);
    try {
      const doc = await registry.read();
      if (!doc) this.error('Registry not initialized. Run: slingshot registry init');

      if (!Object.hasOwn(doc.stacks, stackName)) {
        this.error(`Stack "${stackName}" not found.`);
      }
      const stackEntry = doc.stacks[stackName];

      if (!Object.hasOwn(stackEntry.stages, stageName)) {
        this.error(`Stage "${stageName}" not found on stack "${stackName}".`);
      }

      // Check for active services
      const activeServices = Object.entries(doc.services).filter(
        ([, svc]) => svc.stack === stackName && svc.stages[stageName].status === 'deployed',
      );

      if (activeServices.length > 0 && !flags.yes) {
        const names = activeServices.map(([n]) => n).join(', ');
        this.error(
          `Stage "${stageName}" on stack "${stackName}" still has deployed services: ${names}. ` +
            `Run 'slingshot rollback' or remove the services first, or pass --yes to force removal.`,
        );
      }

      if (!flags.yes) {
        const confirmed = await this.confirm(
          `Remove server entry for stack "${stackName}" stage "${stageName}"? (y/N) `,
        );
        if (!confirmed) {
          this.log('Removal cancelled.');
          return;
        }
      }

      stackEntry.stages = Object.fromEntries(
        Object.entries(stackEntry.stages).filter(([s]) => s !== stageName),
      );

      await registry.write(doc, lock.etag);
    } finally {
      await lock.release();
    }

    this.log(`\u2713 Removed stage "${stageName}" from stack "${stackName}"`);
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
