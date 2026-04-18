import { Args, Command, Flags } from '@oclif/core';
import { createRegistryFromConfig, loadPlatformConfig } from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class ServersInspect extends Command {
  static override description = 'List all services deployed to a stack/stage from all repos';

  static override args = {
    stack: Args.string({ description: 'Stack name', required: true }),
  };

  static override flags = {
    stage: Flags.string({ description: 'Stage name', required: true }),
    platform: Flags.string({ description: 'Target platform (for multi-platform configs)' }),
  };

  async run() {
    const { args, flags } = await this.parse(ServersInspect);
    const { config: rawConfig } = await loadPlatformConfig();
    const config = resolvePlatformConfig(rawConfig, flags.platform);

    const registry = createRegistryFromConfig(config.registry);
    const doc = await registry.read();
    if (!doc) this.error('Registry not initialized. Run: slingshot registry init');

    const { stack: stackName, stage: stageName } = { stack: args.stack, stage: flags.stage };

    if (!Object.hasOwn(doc.stacks, stackName)) {
      this.error(`Stack "${stackName}" not found. Run: slingshot stacks list`);
    }
    const stackEntry = doc.stacks[stackName];

    const stageEntry = stackEntry.stages[stageName];
    const host = stageEntry.outputs.host;

    this.log(`Stack: ${stackName}  Stage: ${stageName}`);
    if (host) {
      const serverName = stageEntry.outputs.serverName;
      this.log(`Host: ${host}${serverName ? `  (${serverName})` : ''}`);
    } else {
      this.log('Host: (not set)');
    }

    const services = Object.entries(doc.services).filter(
      ([, svc]) => svc.stack === stackName && svc.stages[stageName].status === 'deployed',
    );

    if (services.length === 0) {
      this.log('\nNo services deployed on this stack/stage.');
      return;
    }

    this.log('\nServices:');
    const header = `  ${'name'.padEnd(28)} ${'repo'.padEnd(24)} ${'deployed'.padEnd(26)} ${'port'.padEnd(6)} domain`;
    this.log(header);
    this.log('  ' + '-'.repeat(header.length - 2));

    for (const [name, svc] of services) {
      const deployedAt = new Date(svc.stages[stageName].deployedAt).toISOString();
      const port = svc.port != null ? String(svc.port) : '-';
      const domain = svc.domain ?? '-';
      const repo = svc.repo || 'unknown';
      this.log(
        `  ${name.padEnd(28)} ${repo.padEnd(24)} ${deployedAt.padEnd(26)} ${port.padEnd(6)} ${domain}`,
      );
    }
  }
}
