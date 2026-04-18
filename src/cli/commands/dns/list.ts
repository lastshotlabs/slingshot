import { Command } from '@oclif/core';
import { createCloudflareClient, loadPlatformConfig } from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class DnsList extends Command {
  static override description = 'List all DNS records in the configured zone';

  async run() {
    const { config: platform } = await loadPlatformConfig();
    const resolved = resolvePlatformConfig(platform);

    if (!resolved.dns) {
      this.error('No DNS provider configured in slingshot.platform.ts. Add a "dns" section.');
    }

    if (resolved.dns.provider !== 'cloudflare') {
      this.error(
        `DNS listing is only supported for Cloudflare. Current provider: ${resolved.dns.provider}`,
      );
    }

    if (!resolved.dns.apiToken) {
      this.error('Cloudflare apiToken is required. Set it in dns.apiToken.');
    }

    const client = createCloudflareClient({
      apiToken: resolved.dns.apiToken,
      zoneId: resolved.dns.zoneId,
    });

    this.log('Fetching DNS records...\n');

    const records = await client.listRecords();

    if (records.length === 0) {
      this.log('No DNS records found.');
      return;
    }

    const typeWidth = Math.max(...records.map(r => r.type.length), 4);
    const nameWidth = Math.max(...records.map(r => r.name.length), 4);

    this.log(`${'TYPE'.padEnd(typeWidth)}  ${'NAME'.padEnd(nameWidth)}  VALUE  PROXIED  TTL`);
    this.log('-'.repeat(typeWidth + nameWidth + 40));

    for (const r of records) {
      const proxied = r.proxied ? 'yes' : 'no';
      this.log(
        `${r.type.padEnd(typeWidth)}  ${r.name.padEnd(nameWidth)}  ${r.content}  ${proxied.padEnd(7)}  ${r.ttl}`,
      );
    }

    this.log(`\n${records.length} record(s) total.`);
  }
}
