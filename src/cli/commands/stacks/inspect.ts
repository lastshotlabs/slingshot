import { Args, Command, Flags } from '@oclif/core';
import { createRegistryFromConfig, loadPlatformConfig } from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class StacksInspect extends Command {
  static override description = 'Show details of a stack';
  static override args = { name: Args.string({ description: 'Stack name', required: true }) };
  static override flags = {
    platform: Flags.string({ description: 'Target platform (for multi-platform configs)' }),
  };

  async run() {
    const { args, flags } = await this.parse(StacksInspect);
    const { config: rawConfig } = await loadPlatformConfig();

    const config = resolvePlatformConfig(rawConfig, flags.platform);

    const registry = createRegistryFromConfig(config.registry);
    const doc = await registry.read();
    if (!doc) this.error('Registry not initialized. Run: slingshot registry init');

    if (!Object.hasOwn(doc.stacks, args.name))
      this.error(`Stack "${args.name}" not found. Run: slingshot stacks list`);
    const stack = doc.stacks[args.name];

    this.log(`Stack: ${args.name}`);
    this.log(`Preset: ${stack.preset}`);

    const stages = Object.entries(stack.stages).filter(([s]) => s !== '_meta');
    if (stages.length > 0) {
      this.log('\nStages:');
      for (const [s, data] of stages) {
        this.log(`  ${s}: ${data.status}`);
        for (const [k, v] of Object.entries(data.outputs)) this.log(`    ${k}: ${v}`);
      }
    }

    const meta = stack.stages['_meta'];
    this.log('\nMeta:');
    for (const [k, v] of Object.entries(meta.outputs)) this.log(`  ${k}: ${v}`);

    const services = Object.entries(doc.services).filter(([, svc]) => svc.stack === args.name);
    if (services.length > 0) {
      this.log('\nServices:');
      for (const [name, svc] of services) {
        const info = Object.entries(svc.stages)
          .map(([s, d]) => `${s}: ${d.status} (${d.imageTag})`)
          .join(', ');
        this.log(`  ${name}  repo: ${svc.repo || 'local'}  ${info}`);
      }
    }
  }
}
