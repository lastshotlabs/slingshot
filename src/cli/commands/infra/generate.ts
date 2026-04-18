import { Command, Flags } from '@oclif/core';
import {
  createEc2NginxPreset,
  createEcsPreset,
  createPresetRegistry,
  createRegistryFromConfig,
  loadInfraConfig,
  loadPlatformConfig,
  runDeployPipeline,
} from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class InfraGenerate extends Command {
  static override description = 'Preview generated infrastructure files (dry run)';
  static override flags = {
    stage: Flags.string({ description: 'Stage to generate for', required: true }),
  };

  async run() {
    const { flags } = await this.parse(InfraGenerate);
    const { config: platform } = await loadPlatformConfig();
    const { config: infra, configPath } = await loadInfraConfig();
    const appRoot = configPath.replace(/\/slingshot\.infra\.\w+$/, '');

    const resolvedPlatform = resolvePlatformConfig(platform, infra.platform);
    const registry = createRegistryFromConfig(resolvedPlatform.registry);
    const presets = createPresetRegistry([createEcsPreset(), createEc2NginxPreset()]);

    await runDeployPipeline({
      platform,
      infra,
      stageName: flags.stage,
      registry,
      presetRegistry: presets,
      appRoot,
      dryRun: true,
    });
  }
}
