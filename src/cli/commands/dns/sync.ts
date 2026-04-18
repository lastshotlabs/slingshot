import { Command, Flags } from '@oclif/core';
import {
  createDnsManager,
  loadInfraConfig,
  loadPlatformConfig,
} from '@lastshotlabs/slingshot-infra';
import { resolveDomain } from '../../../../packages/slingshot-infra/src/preset/resolveDomain';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class DnsSync extends Command {
  static override description = 'Ensure DNS records match the current infra config for a stage';

  static override flags = {
    stage: Flags.string({ description: 'Stage to sync DNS for', required: true }),
    'dry-run': Flags.boolean({
      description: 'Show what would be created/updated without making changes',
      default: false,
    }),
  };

  async run() {
    const { flags } = await this.parse(DnsSync);
    const { config: platform } = await loadPlatformConfig();
    const { config: infra } = await loadInfraConfig();
    const resolved = resolvePlatformConfig(platform, infra.platform);

    if (!resolved.dns) {
      this.error('No DNS provider configured in slingshot.platform.ts. Add a "dns" section.');
    }

    const stage = resolved.stages[flags.stage];

    const dnsManager = createDnsManager(resolved.dns);
    const domains: Array<{ service: string; domain: string }> = [];

    if (infra.domain) {
      const domainConfig = infra.domains?.['default'];
      const domain = resolveDomain(infra.domain, flags.stage, stage, domainConfig);
      domains.push({ service: 'default', domain });
    }

    if (domains.length === 0) {
      this.log('No domains configured in infra config.');
      return;
    }

    this.log(`Syncing DNS for stage "${flags.stage}"...\n`);

    for (const { service, domain } of domains) {
      if (flags['dry-run']) {
        this.log(`  [dry-run] Would ensure record for ${service}: ${domain}`);
      } else {
        try {
          await dnsManager.ensureRecords({ domain, target: domain, type: 'CNAME' });
          this.log(`  \u2713 ${service}: ${domain}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`  \u2717 ${service}: ${domain} \u2014 ${msg}`);
        }
      }
    }

    this.log('');
    this.log(flags['dry-run'] ? 'Dry run complete.' : 'DNS sync complete.');
  }
}
