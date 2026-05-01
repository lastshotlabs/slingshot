import type { DnsProviderConfig } from '../types/platform';
import { createCloudflareClient } from './cloudflare';
import type { DnsClient } from './cloudflare';

/**
 * High-level DNS management interface used by the deploy pipeline.
 *
 * Implementations are created by `createDnsManager()` based on the
 * `DnsProviderConfig.provider` field: `'cloudflare'` is fully implemented,
 * `'manual'` logs instructions without making API calls, and `'route53'`
 * throws on every method until implemented.
 */
export interface DnsManager {
  /**
   * Create or update a DNS record pointing `domain` to `target`.
   * The record type defaults to `'A'` for IP addresses and `'CNAME'` for
   * hostnames unless `type` is specified.
   */
  ensureRecords(opts: {
    domain: string;
    target: string; // IP for A record, hostname for CNAME
    type?: 'A' | 'CNAME';
  }): Promise<void>;

  /** Delete all DNS records for the given fully-qualified domain. */
  removeRecords(domain: string): Promise<void>;

  /**
   * Check whether the DNS record for `domain` has propagated to
   * `expectedValue`. Uses Cloudflare's DNS-over-HTTPS resolver.
   * Always returns `false` for the `'manual'` provider.
   */
  verifyPropagation(domain: string, expectedValue: string): Promise<boolean>;
}

/**
 * Dispatch to the correct DNS manager implementation based on
 * `DnsProviderConfig.provider`.
 *
 * @param config - DNS provider config from `DefinePlatformConfig.dns`.
 * @returns A `DnsManager` backed by Cloudflare, a manual no-op, or a
 *   Route53 stub.
 *
 * @throws {Error} If provider is `'cloudflare'` and `config.apiToken` is missing.
 * @throws {Error} If provider is `'route53'` (not yet implemented).
 *
 * @example
 * ```ts
 * import { createDnsManager } from '@lastshotlabs/slingshot-infra';
 *
 * const dns = createDnsManager({ provider: 'cloudflare', apiToken: process.env.CF_API_TOKEN! });
 * await dns.ensureRecords({ domain: 'api.example.com', target: '1.2.3.4' });
 * ```
 */
export function createDnsManager(config: DnsProviderConfig): DnsManager {
  if (config.provider === 'manual') {
    return createManualManager();
  }

  if (config.provider === 'route53') {
    return createRoute53Stub();
  }

  if (!config.apiToken) {
    throw new Error('[dns] Cloudflare provider requires an apiToken');
  }

  const client = createCloudflareClient({
    apiToken: config.apiToken,
    zoneId: config.zoneId,
  });

  return createCloudflareManager(client, config.proxied);
}

/**
 * Create a `DnsManager` backed by the Cloudflare DNS API.
 *
 * Delegates all operations to the provided `DnsClient` (created via
 * `createCloudflareClient()`). Record type defaults to `'A'` for IPv4
 * addresses and `'CNAME'` for hostnames unless overridden by the caller.
 * Propagation verification queries Cloudflare's DNS-over-HTTPS resolver
 * (`cloudflare-dns.com/dns-query`).
 *
 * @param client - A `DnsClient` instance configured with an API token and zone ID.
 * @param proxied - Whether to enable Cloudflare proxy (orange-cloud) for new records.
 *   Defaults to `true` when not specified.
 * @returns A fully-operational `DnsManager` for the Cloudflare provider.
 */
function createCloudflareManager(client: DnsClient, proxied?: boolean): DnsManager {
  return {
    async ensureRecords(opts) {
      const type = opts.type ?? (isIpAddress(opts.target) ? 'A' : 'CNAME');
      await client.upsertRecord({
        domain: opts.domain,
        type,
        value: opts.target,
        proxied: proxied ?? true,
      });
      console.log(`[dns] Upserted ${type} record: ${opts.domain} -> ${opts.target}`);
    },

    async removeRecords(domain) {
      await client.deleteRecord(domain);
      console.log(`[dns] Removed records for ${domain}`);
    },

    async verifyPropagation(domain, expectedValue) {
      // Simple DNS check via Cloudflare's DNS-over-HTTPS resolver
      try {
        const res = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`,
          { headers: { Accept: 'application/dns-json' } },
        );
        const data = (await res.json()) as { Answer?: Array<{ data: string }> };
        const answers = data.Answer ?? [];
        return answers.some(a => a.data === expectedValue);
      } catch {
        // DNS-over-HTTPS lookup failed — treat as unverified
        return false;
      }
    },
  };
}

/**
 * Create a no-op `DnsManager` for the `'manual'` DNS provider.
 *
 * All operations log human-readable instructions to `console.log` instead of
 * making API calls. This is the correct choice when DNS records are managed
 * outside the deploy pipeline (e.g. via the hosting provider's web UI or a
 * DNS provider not yet supported).
 *
 * `verifyPropagation()` always returns `false` because there is no automated
 * mechanism to confirm manual changes have propagated.
 *
 * @returns A `DnsManager` that logs instructions without performing any DNS mutations.
 */
function createManualManager(): DnsManager {
  return {
    ensureRecords(opts) {
      const type = opts.type ?? (isIpAddress(opts.target) ? 'A' : 'CNAME');
      console.log(`[dns:manual] Please create ${type} record: ${opts.domain} -> ${opts.target}`);
      return Promise.resolve();
    },
    removeRecords(domain) {
      console.log(`[dns:manual] Please remove DNS records for: ${domain}`);
      return Promise.resolve();
    },
    verifyPropagation() {
      console.log('[dns:manual] Skipping DNS propagation check (manual provider)');
      return Promise.resolve(false);
    },
  };
}

/**
 * Create a stub `DnsManager` for the `'route53'` DNS provider.
 *
 * Every method throws `Error('[dns] Route53 provider is not yet implemented')`.
 * This is a placeholder to satisfy the provider dispatch in `createDnsManager()`
 * until a real Route 53 implementation is written.
 *
 * @returns A `DnsManager` where every method unconditionally throws.
 */
function createRoute53Stub(): DnsManager {
  const err = (): Promise<never> =>
    Promise.reject(new Error('[dns] Route53 provider is not yet implemented'));
  return {
    ensureRecords: err,
    removeRecords: err,
    verifyPropagation: err,
  };
}

/**
 * Test whether a string looks like an IPv4 address.
 *
 * Uses a simple octet pattern (`\d{1,3}` × 4) rather than a strict range
 * validator. The sole purpose is to choose between `'A'` and `'CNAME'` record
 * types when no explicit type is provided — precision beyond that is not needed.
 *
 * @param value - The string to test (typically a deploy target IP or hostname).
 * @returns `true` if `value` matches the `d.d.d.d` pattern, `false` otherwise.
 *
 * @example
 * ```ts
 * isIpAddress('1.2.3.4')       // true
 * isIpAddress('api.example.com') // false
 * ```
 */
function isIpAddress(value: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}
