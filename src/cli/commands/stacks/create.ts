import { Args, Command, Flags } from '@oclif/core';
import { createRegistryFromConfig, loadPlatformConfig } from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class StacksCreate extends Command {
  static override description = 'Register a new stack in the registry';
  static override args = { name: Args.string({ description: 'Stack name', required: true }) };
  static override flags = {
    preset: Flags.string({
      description: 'Preset to use',
      required: true,
      options: ['ecs', 'ec2-nginx'],
    }),
    host: Flags.string({ description: 'EC2 host IP (ec2-nginx only)' }),
    platform: Flags.string({ description: 'Target platform (for multi-platform configs)' }),
  };

  async run() {
    const { args, flags } = await this.parse(StacksCreate);
    const { config: rawConfig } = await loadPlatformConfig();

    const config = resolvePlatformConfig(rawConfig, flags.platform);

    const registry = createRegistryFromConfig(config.registry);
    const doc = await registry.read();
    if (!doc) this.error('Registry not initialized. Run: slingshot registry init');
    if (Object.hasOwn(doc.stacks, args.name)) this.error(`Stack "${args.name}" already exists.`);

    doc.stacks[args.name] = { preset: flags.preset, stages: {} };
    if (flags.host) {
      doc.stacks[args.name].stages['_meta'] = {
        status: 'active',
        outputs: { publicIp: flags.host },
        updatedAt: new Date().toISOString(),
      };
    }

    const lock = await registry.lock();
    await registry.write(doc, lock.etag);
    await lock.release();
    this.log(`\u2713 Stack "${args.name}" registered (preset: ${flags.preset})`);
    if (flags.host) this.log(`  Host: ${flags.host}`);
  }
}
