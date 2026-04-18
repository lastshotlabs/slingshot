import { Command, Flags } from '@oclif/core';
import {
  createSecretsManager,
  loadInfraConfig,
  loadPlatformConfig,
  resolveRequiredKeys,
} from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class SecretsPull extends Command {
  static override description = 'Pull secrets from the remote provider to local .env';
  static override flags = {
    stage: Flags.string({ description: 'Stage to pull secrets for', required: true }),
  };

  async run() {
    const { flags } = await this.parse(SecretsPull);
    const { config: platform } = await loadPlatformConfig();
    const { config: infra, configPath } = await loadInfraConfig();
    const resolved = resolvePlatformConfig(platform, infra.platform);
    if (!resolved.secrets) this.error('No secrets provider configured in slingshot.platform.ts');

    const appRoot = configPath.replace(/\/slingshot\.infra\.\w+$/, '');
    const manager = createSecretsManager(resolved.secrets, flags.stage);

    this.log(`Pulling secrets from ${resolved.secrets.provider} for stage "${flags.stage}"...`);
    const result = await manager.pull(appRoot, resolveRequiredKeys(infra));
    this.log(`\u2713 Pulled ${result.pulled.length} secrets: ${result.pulled.join(', ')}`);
  }
}
