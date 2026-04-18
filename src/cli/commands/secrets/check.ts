import { Command, Flags } from '@oclif/core';
import {
  createSecretsManager,
  loadInfraConfig,
  loadPlatformConfig,
  resolveRequiredKeys,
} from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class SecretsCheck extends Command {
  static override description = 'Check that all required secrets exist in the remote provider';
  static override flags = {
    stage: Flags.string({ description: 'Stage to check secrets for', required: true }),
  };

  async run() {
    const { flags } = await this.parse(SecretsCheck);
    const { config: platform } = await loadPlatformConfig();
    const { config: infra } = await loadInfraConfig();
    const resolved = resolvePlatformConfig(platform, infra.platform);
    if (!resolved.secrets) this.error('No secrets provider configured in slingshot.platform.ts');

    const manager = createSecretsManager(resolved.secrets, flags.stage);
    this.log(`Checking secrets in ${resolved.secrets.provider} for stage "${flags.stage}"...\n`);
    const result = await manager.check(resolveRequiredKeys(infra));

    for (const key of result.found) this.log(`  \u2713 ${key}`);
    for (const key of result.missing) this.log(`  \u2717 ${key} — MISSING`);
    this.log('');

    if (result.missing.length > 0) {
      this.log(
        `${result.missing.length} missing secret(s). Run: slingshot secrets push --stage ${flags.stage}`,
      );
      this.exit(1);
    } else {
      this.log('\u2713 All secrets present');
    }
  }
}
