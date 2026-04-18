import { Command, Flags } from '@oclif/core';
import { createRegistryFromConfig, loadPlatformConfig } from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class PlatformSync extends Command {
  static override description = 'Sync platform config to the registry';

  static override flags = {
    platform: Flags.string({ description: 'Target platform (for multi-platform configs)' }),
  };

  async run() {
    const { flags } = await this.parse(PlatformSync);
    const { config: rawConfig } = await loadPlatformConfig();

    const config = resolvePlatformConfig(rawConfig, flags.platform);

    const registry = createRegistryFromConfig(config.registry);
    const lock = await registry.lock(120000);
    try {
      const doc = await registry.read();
      if (!doc) this.error('Registry not initialized. Run: slingshot registry init');

      doc.platform = config.org;
      doc.platformConfig = config;
      doc.updatedAt = new Date().toISOString();
      if (config.stacks) {
        for (const [name, stack] of Object.entries(config.stacks)) {
          doc.stacks[name].preset = stack.preset;
        }
      }

      await registry.write(doc, lock.etag);
    } finally {
      await lock.release();
    }
    this.log('\u2713 Platform config synced to registry');
  }
}
