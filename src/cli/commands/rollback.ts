import * as readline from 'node:readline';
import { Command, Flags } from '@oclif/core';
import {
  createEc2NginxPreset,
  createEcsPreset,
  createPresetRegistry,
  createRegistryFromConfig,
  loadInfraConfig,
  loadPlatformConfig,
  runRollback,
} from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../utils/resolvePlatformConfig';

export default class Rollback extends Command {
  static override description = 'Roll back a deployed service to a previous image tag';

  static override flags = {
    stage: Flags.string({ description: 'Stage to roll back', required: true }),
    service: Flags.string({ description: 'Specific service to roll back (default: all)' }),
    tag: Flags.string({ description: 'Target image tag to roll back to (default: previous)' }),
    yes: Flags.boolean({ char: 'y', description: 'Skip confirmation prompt', default: false }),
  };

  async run() {
    const { flags } = await this.parse(Rollback);
    const { config: platform } = await loadPlatformConfig();
    const { config: infra, configPath } = await loadInfraConfig();
    const appRoot = configPath.replace(/\/slingshot\.infra\.\w+$/, '');

    const resolvedPlatform = resolvePlatformConfig(platform, infra.platform);
    const registry = createRegistryFromConfig(resolvedPlatform.registry);
    const presets = createPresetRegistry([createEcsPreset(), createEc2NginxPreset()]);

    // Read registry to show what will be rolled back
    const registryDoc = await registry.read();
    if (!registryDoc) {
      this.error('Registry not initialized. Run: slingshot registry init');
    }

    const serviceNames = flags.service
      ? [flags.service]
      : Object.keys(registryDoc.services).filter(name =>
          Object.hasOwn(registryDoc.services[name].stages, flags.stage),
        );

    if (serviceNames.length === 0) {
      this.error(`No services found for stage "${flags.stage}".`);
    }

    // Show rollback plan
    this.log(`\nRollback plan for stage "${flags.stage}":\n`);
    for (const name of serviceNames) {
      const stageData = registryDoc.services[name].stages[flags.stage];

      const currentTag = stageData.imageTag;
      let targetTag = flags.tag ?? '(previous)';
      if (!flags.tag && stageData.previousTags?.length) {
        targetTag = stageData.previousTags[stageData.previousTags.length - 1].imageTag;
      }
      this.log(`  ${name}: ${currentTag} -> ${targetTag}`);
    }
    this.log('');

    if (!flags.yes) {
      const confirmed = await this.confirm('Proceed with rollback? (y/N) ');
      if (!confirmed) {
        this.log('Rollback cancelled.');
        return;
      }
    }

    this.log('Rolling back...');

    const result = await runRollback({
      platform,
      infra,
      stageName: flags.stage,
      registry,
      presetRegistry: presets,
      appRoot,
      serviceName: flags.service,
      targetTag: flags.tag,
    });

    this.log('');
    for (const svc of result.services) {
      const icon = svc.success ? '\u2713' : '\u2717';
      if (svc.success) {
        this.log(`  ${icon} ${svc.name}: ${svc.previousTag} -> ${svc.rolledBackTag}`);
      } else {
        this.log(`  ${icon} ${svc.name}: ${svc.error}`);
      }
    }
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
