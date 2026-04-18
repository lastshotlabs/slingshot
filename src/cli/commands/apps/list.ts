import { Command, Flags } from '@oclif/core';
import { createRegistryFromConfig, loadPlatformConfig } from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class AppsList extends Command {
  static override description = 'List all registered apps in the platform registry';

  static override flags = {
    platform: Flags.string({ description: 'Target platform (for multi-platform configs)' }),
  };

  async run() {
    const { flags } = await this.parse(AppsList);
    const { config: rawConfig } = await loadPlatformConfig();

    const config = resolvePlatformConfig(rawConfig, flags.platform);

    const registry = createRegistryFromConfig(config.registry);
    const doc = await registry.read();
    if (!doc) this.error('Registry not initialized. Run: slingshot registry init');

    const apps = doc.apps ? Object.values(doc.apps) : [];
    if (apps.length === 0) {
      this.log('No apps registered.');
      return;
    }

    this.log('Apps:\n');
    for (const app of apps) {
      const stacks = app.stacks.join(', ') || 'none';
      const uses = app.uses.join(', ') || 'none';
      const registered = app.registeredAt ? new Date(app.registeredAt).toLocaleString() : 'unknown';
      this.log(`  ${app.name}`);
      this.log(`    repo:       ${app.repo || 'local'}`);
      this.log(`    stacks:     ${stacks}`);
      this.log(`    uses:       ${uses}`);
      this.log(`    registered: ${registered}`);
      this.log('');
    }
  }
}
