import { Command, Flags } from '@oclif/core';
import { createRegistryFromConfig, loadPlatformConfig } from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class StacksList extends Command {
  static override description = 'List all registered stacks';

  static override flags = {
    platform: Flags.string({ description: 'Target platform (for multi-platform configs)' }),
  };

  async run() {
    const { flags } = await this.parse(StacksList);
    const { config: rawConfig } = await loadPlatformConfig();

    const config = resolvePlatformConfig(rawConfig, flags.platform);

    const registry = createRegistryFromConfig(config.registry);
    const doc = await registry.read();
    if (!doc) this.error('Registry not initialized. Run: slingshot registry init');

    const stacks = Object.entries(doc.stacks);
    if (stacks.length === 0) {
      this.log('No stacks registered.');
      return;
    }

    this.log('Stacks:\n');
    for (const [name, stack] of stacks) {
      const stages =
        Object.keys(stack.stages)
          .filter(s => s !== '_meta')
          .join(', ') || 'none';
      this.log(`  ${name}  (${stack.preset})  stages: ${stages}`);
    }

    const services = Object.entries(doc.services);
    if (services.length > 0) {
      this.log('\nServices:\n');
      for (const [name, svc] of services) {
        const info = Object.entries(svc.stages)
          .map(([s, d]) => `${s}: ${d.status}`)
          .join(', ');
        this.log(`  ${name} -> ${svc.stack}  (${info || 'not deployed'})`);
      }
    }
  }
}
