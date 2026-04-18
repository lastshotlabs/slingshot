import { Args, Command, Flags } from '@oclif/core';
import { createRegistryFromConfig, loadPlatformConfig } from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class AppsInspect extends Command {
  static override description = 'Show detailed info about a registered app';
  static override args = { name: Args.string({ description: 'App name', required: true }) };
  static override flags = {
    platform: Flags.string({ description: 'Target platform (for multi-platform configs)' }),
  };

  async run() {
    const { args, flags } = await this.parse(AppsInspect);
    const { config: rawConfig } = await loadPlatformConfig();

    const config = resolvePlatformConfig(rawConfig, flags.platform);

    const registry = createRegistryFromConfig(config.registry);
    const doc = await registry.read();
    if (!doc) this.error('Registry not initialized. Run: slingshot registry init');

    const app = doc.apps?.[args.name];
    if (!app) this.error(`App "${args.name}" not found. Run: slingshot apps list`);

    this.log(`App: ${app.name}`);
    this.log(`Repo: ${app.repo || 'local'}`);
    this.log(
      `Registered: ${app.registeredAt ? new Date(app.registeredAt).toLocaleString() : 'unknown'}`,
    );

    if (app.stacks.length > 0) {
      this.log('\nStacks:');
      for (const stackName of app.stacks) {
        const stack = doc.stacks[stackName];
        const stages =
          Object.keys(stack.stages)
            .filter(s => s !== '_meta')
            .join(', ') || 'none';
        this.log(`  ${stackName}  (${stack.preset})  stages: ${stages}`);
      }
    }

    if (app.uses.length > 0) {
      this.log('\nResources:');
      for (const resourceName of app.uses) {
        const resource = doc.resources[resourceName];
        const stages = Object.entries(resource.stages)
          .map(([s, d]) => `${s}: ${d.status}`)
          .join(', ');
        this.log(`  ${resourceName}  (${resource.type})  ${stages || 'no stages'}`);
      }
    }

    // Show services associated with this app
    const appServices = Object.entries(doc.services).filter(([, svc]) =>
      app.stacks.includes(svc.stack),
    );
    if (appServices.length > 0) {
      this.log('\nServices:');
      for (const [name, svc] of appServices) {
        const info = Object.entries(svc.stages)
          .map(([s, d]) => `${s}: ${d.status} (${d.deployedAt})`)
          .join(', ');
        this.log(`  ${name} -> ${svc.stack}  ${info || 'not deployed'}`);
      }
    }
  }
}
