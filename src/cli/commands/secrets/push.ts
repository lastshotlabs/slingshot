import { Command, Flags } from '@oclif/core';
import {
  createSecretsManager,
  loadInfraConfig,
  loadPlatformConfig,
  resolveRequiredKeys,
} from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class SecretsPush extends Command {
  static override description = 'Push local .env secrets to the remote provider';
  static override flags = {
    stage: Flags.string({ description: 'Stage to push secrets for', required: true }),
  };

  async run() {
    const { flags } = await this.parse(SecretsPush);
    const { config: platform } = await loadPlatformConfig();
    const { config: infra, configPath } = await loadInfraConfig();
    const resolved = resolvePlatformConfig(platform, infra.platform);
    if (!resolved.secrets) this.error('No secrets provider configured in slingshot.platform.ts');

    const appRoot = configPath.replace(/\/slingshot\.infra\.\w+$/, '');
    const manager = createSecretsManager(resolved.secrets, flags.stage);

    this.log(`Pushing secrets to ${resolved.secrets.provider} for stage "${flags.stage}"...`);
    const result = await manager.push(appRoot, resolveRequiredKeys(infra));
    this.log(`\u2713 Pushed ${result.pushed.length} secrets: ${result.pushed.join(', ')}`);
  }
}
