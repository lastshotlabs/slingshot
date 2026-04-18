import { Command, Flags } from '@oclif/core';
import { createRegistryFromConfig, loadPlatformConfig } from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class RegistryInit extends Command {
  static override description =
    'Initialize the slingshot registry (create S3 bucket or local file)';

  static override flags = {
    platform: Flags.string({ description: 'Target platform (for multi-platform configs)' }),
  };

  async run() {
    const { flags } = await this.parse(RegistryInit);
    const { config: rawConfig } = await loadPlatformConfig();

    const config = resolvePlatformConfig(rawConfig, flags.platform);

    const registry = createRegistryFromConfig(config.registry);

    this.log(`Initializing ${config.registry.provider} registry...`);
    await registry.initialize();

    if (config.registry.provider === 's3') {
      this.log(`\u2713 S3 bucket "${config.registry.bucket}" ready with versioning enabled`);
      this.log(`\nSet in CI: SLINGSHOT_REGISTRY=s3://${config.registry.bucket}`);
    } else {
      this.log(`\u2713 Local registry created at ${config.registry.path}`);
    }
  }
}
