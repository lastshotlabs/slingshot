const CF_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * A single DNS record returned by the Cloudflare API.
 */
export interface DnsRecord {
  /** Cloudflare record ID. */
  id: string;
  /** Record type (A, AAAA, CNAME, etc.). */
  type: string;
  /** Fully qualified record name (e.g. `'api.example.com'`). */
  name: string;
  /** Record value (IP address or CNAME target). */
  content: string;
  /** Whether the record is proxied through Cloudflare (orange cloud). */
  proxied: boolean;
  /** TTL in seconds. `1` means "Auto" when proxied. */
  ttl: number;
}

/**
 * Minimal DNS client interface used by `createDnsManager()`.
 *
 * All implementations must support upsert, delete, list, and zone resolution.
 * The Cloudflare implementation is the only concrete provider — Route53 is a
 * stub that throws on every method.
 */
export interface DnsClient {
  /**
   * Create or update a DNS record in the zone.
   *
   * @remarks
   * Checks for an existing record with the same `domain` (name) and `type` first.
   * If one exists, it is updated via `PUT`; otherwise a new record is created via `POST`.
   * When multiple records match by name+type, only the first is updated — duplicates
   * are not removed. `proxied` defaults to `true` (Cloudflare orange-cloud proxy).
   * `ttl` defaults to `1` (Auto) when proxied, or `300` when not proxied.
   *
   * @param opts.domain - Fully-qualified domain name for the record (e.g. `'api.example.com'`).
   * @param opts.type - DNS record type: `'A'` (IPv4), `'AAAA'` (IPv6), or `'CNAME'`.
   * @param opts.value - Record value: IP address for A/AAAA records, hostname for CNAME records.
   * @param opts.proxied - Whether to enable the Cloudflare proxy (orange cloud). Default: `true`.
   * @param opts.ttl - TTL in seconds. Default: `1` (Auto) when proxied, `300` otherwise.
   * @returns Object with the Cloudflare record `id` and `success: true`.
   *
   * @throws {Error} If the zone cannot be resolved (domain not in the account).
   * @throws {Error} If the Cloudflare API returns an error.
   */
  upsertRecord(opts: {
    domain: string;
    type: 'A' | 'AAAA' | 'CNAME';
    value: string;
    proxied?: boolean;
    ttl?: number;
  }): Promise<{ id: string; success: boolean }>;

  /**
   * Delete all DNS records in the zone that match the given domain name and optional type.
   *
   * @remarks
   * Resolves matching records via `listRecords()` then issues a `DELETE` for each one.
   * **No-op if no records match** — returns without error when the record does not exist.
   * When multiple records share the same name (e.g. both A and CNAME), all are deleted
   * unless `type` is provided to restrict deletion to a single record type.
   *
   * @param domain - Fully-qualified domain name to delete records for (e.g. `'api.example.com'`).
   * @param type - Optional record type filter (e.g. `'A'`). When omitted, all types for
   *   `domain` are deleted.
   *
   * @throws {Error} If the zone cannot be resolved (domain not in the account).
   * @throws {Error} If the Cloudflare API returns an error during the delete call.
   */
  deleteRecord(domain: string, type?: string): Promise<void>;

  /**
   * List all DNS records in the zone, with optional name and type filtering.
   *
   * @remarks
   * Paginates automatically through all result pages (100 records per page) until
   * no more pages remain, so the returned array contains **all** matching records
   * regardless of the total count. When `opts.name` is provided, it is also used
   * to resolve the zone ID lazily.
   *
   * @param opts.type - Filter by record type (e.g. `'A'`, `'CNAME'`). When omitted, all types are returned.
   * @param opts.name - Filter by fully-qualified record name (e.g. `'api.example.com'`).
   *   Also used for lazy zone ID resolution when `config.zoneId` was not provided at construction.
   * @returns All matching `DnsRecord` objects across all pages.
   *
   * @throws {Error} If the zone cannot be resolved (see `resolveZoneId`).
   * @throws {Error} If the Cloudflare API returns an error on any page request.
   */
  listRecords(opts?: { type?: string; name?: string }): Promise<DnsRecord[]>;

  /**
   * Resolve the Cloudflare zone ID for the given fully-qualified domain name.
   *
   * @remarks
   * Strips all subdomains and queries `/zones?name=<baseDomain>`. Returns the ID
   * of the first matching zone. The result is cached for the lifetime of the client.
   *
   * @param domain - A fully-qualified domain name (e.g. `'api.example.com'`).
   *   The last two labels are used as the base domain for the zone query
   *   (e.g. `'api.example.com'` → queries zone for `'example.com'`).
   * @returns The Cloudflare zone ID string (e.g. `'023e105f4ecef8ad9ca31a8372d0c353'`).
   *
   * @throws {Error} If no Cloudflare zone is found for the derived base domain
   *   (message: `'[cloudflare] No zone found for domain "<baseDomain>"'`).
   * @throws {Error} If the Cloudflare API returns an error.
   */
  resolveZoneId(domain: string): Promise<string>;
}

interface CloudflareApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { page: number; per_page: number; total_count: number; total_pages: number };
}

/**
 * Create a `DnsClient` backed by the Cloudflare v4 API.
 *
 * Zone ID resolution is lazy — if `config.zoneId` is not provided it is
 * resolved on the first API call by looking up the base domain in
 * `/zones?name=<baseDomain>` and cached for the lifetime of the client.
 *
 * All API calls use Bearer token auth. An error is thrown if the Cloudflare
 * API returns `success: false`.
 *
 * @param config - Cloudflare API token and optional pre-resolved zone ID.
 * @returns A `DnsClient` that targets the specified Cloudflare zone.
 *
 * @throws {Error} If `config.zoneId` is absent and a method is called without
 *   a domain argument to resolve the zone from (message contains
 *   `'No zoneId configured and no domain to resolve from'`).
 * @throws {Error} If no Cloudflare zone exists for the derived base domain
 *   (message contains `'No zone found for domain'`).
 * @throws {Error} If any Cloudflare API request returns `success: false` —
 *   the error message contains the Cloudflare API error description.
 *
 * @example
 * ```ts
 * import { createCloudflareClient } from '@lastshotlabs/slingshot-infra';
 *
 * const client = createCloudflareClient({ apiToken: process.env.CF_API_TOKEN! });
 * await client.upsertRecord({ domain: 'api.example.com', type: 'A', value: '1.2.3.4' });
 * ```
 */
export function createCloudflareClient(config: { apiToken: string; zoneId?: string }): DnsClient {
  let cachedZoneId = config.zoneId;

  function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
    if (!headers) {
      return {};
    }
    return Object.fromEntries(new Headers(headers).entries());
  }

  /**
   * Make an authenticated request to the Cloudflare v4 API.
   *
   * Attaches a `Bearer` token `Authorization` header and merges any additional
   * headers from `init`. Parses the response as `CloudflareApiResponse<T>` and
   * throws if the API returns `success: false`.
   *
   * @param path - API path relative to `CF_BASE` (e.g. `'/zones'`).
   * @param init - Optional `fetch` init options (method, body, extra headers).
   * @returns The parsed `CloudflareApiResponse<T>`.
   *
   * @throws {Error} If the Cloudflare API returns `success: false` — the error
   *   message is a semicolon-joined list of all API error messages.
   */
  async function cfFetch<T>(path: string, init?: RequestInit): Promise<CloudflareApiResponse<T>> {
    const res = await fetch(`${CF_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
        ...toHeaderRecord(init?.headers),
      },
    });

    const body = (await res.json()) as CloudflareApiResponse<T>;
    if (!body.success) {
      const msgs = body.errors.map(e => e.message).join('; ');
      throw new Error(`[cloudflare] API error: ${msgs}`);
    }
    return body;
  }

  /**
   * Return the zone ID for the client, resolving it lazily from `domain` if
   * `config.zoneId` was not provided at construction time.
   *
   * The resolved value is cached for the lifetime of the client so subsequent
   * calls that pass the same domain incur only a single `/zones` lookup.
   *
   * @param domain - A fully-qualified domain name used to derive the base domain
   *   for zone lookup (e.g. `'api.example.com'` → resolves zone for `'example.com'`).
   *   Required when `config.zoneId` is absent.
   * @returns The Cloudflare zone ID.
   *
   * @throws {Error} If neither `config.zoneId` nor `domain` is available.
   * @throws {Error} If no zone is found for the derived base domain.
   */
  async function getZoneId(domain?: string): Promise<string> {
    if (cachedZoneId) return cachedZoneId;
    if (!domain) throw new Error('[cloudflare] No zoneId configured and no domain to resolve from');
    cachedZoneId = await resolveZoneId(domain);
    return cachedZoneId;
  }

  /**
   * Resolve a Cloudflare zone ID from a fully-qualified domain name.
   *
   * Strips all subdomains and queries `/zones?name=<baseDomain>`. Returns the
   * ID of the first matching zone. The result is **not** cached here — caching
   * is handled by `getZoneId()`.
   *
   * @param domain - A fully-qualified domain name (e.g. `'api.example.com'`).
   *   The last two labels are used as the base domain for the zone query.
   * @returns The Cloudflare zone ID for the base domain.
   *
   * @throws {Error} If the Cloudflare API returns no zone for the derived base domain.
   */
  async function resolveZoneId(domain: string): Promise<string> {
    // Extract base domain (last two parts) for zone lookup
    const parts = domain.split('.');
    const baseDomain = parts.length >= 2 ? parts.slice(-2).join('.') : domain;

    const resp = await cfFetch<Array<{ id: string; name: string }>>(
      `/zones?name=${encodeURIComponent(baseDomain)}`,
    );
    if (!resp.result.length) {
      throw new Error(`[cloudflare] No zone found for domain "${baseDomain}"`);
    }
    return resp.result[0].id;
  }

  /**
   * List all DNS records in the zone, with optional type and name filtering.
   *
   * Paginates automatically through all result pages (100 records per page)
   * until no more pages remain. When `opts.name` is provided, it is also used
   * to resolve the zone ID lazily.
   *
   * @param opts.type - Filter by record type (e.g. `'A'`, `'CNAME'`).
   * @param opts.name - Filter by fully-qualified record name. Also used for
   *   lazy zone ID resolution when `config.zoneId` was not supplied.
   * @returns All matching `DnsRecord` objects across all pages.
   *
   * @throws {Error} If the zone cannot be resolved (see `getZoneId`).
   * @throws {Error} If the Cloudflare API returns an error on any page request.
   */
  async function listRecords(opts?: { type?: string; name?: string }): Promise<DnsRecord[]> {
    const zoneId = await getZoneId(opts?.name);
    const records: DnsRecord[] = [];
    let page = 1;
    const perPage = 100;

    for (;;) {
      const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
      if (opts?.type) params.set('type', opts.type);
      if (opts?.name) params.set('name', opts.name);

      const resp = await cfFetch<DnsRecord[]>(`/zones/${zoneId}/dns_records?${params.toString()}`);
      records.push(...resp.result);

      if (!resp.result_info || page >= resp.result_info.total_pages) break;
      page++;
    }

    return records;
  }

  /**
   * Create or update a DNS record in the zone.
   *
   * Checks for an existing record with the same `name` and `type` first. If one
   * exists, it is updated via `PUT`; otherwise a new record is created via
   * `POST`. When multiple records match, only the first is updated — duplicates
   * are not removed.
   *
   * Defaults:
   * - `proxied` defaults to `true` (Cloudflare orange-cloud proxy enabled).
   * - `ttl` defaults to `1` (Auto) when proxied, or `300` when not proxied.
   *
   * @param opts.domain - Fully-qualified domain name for the record.
   * @param opts.type - DNS record type (`'A'`, `'AAAA'`, or `'CNAME'`).
   * @param opts.value - Record value: IP address for A/AAAA, hostname for CNAME.
   * @param opts.proxied - Whether to enable Cloudflare proxy. Default: `true`.
   * @param opts.ttl - TTL in seconds. Default: `1` (Auto) when proxied, `300` otherwise.
   * @returns Object with the Cloudflare record `id` and `success: true`.
   *
   * @throws {Error} If the zone cannot be resolved (see `getZoneId`).
   * @throws {Error} If the Cloudflare API returns an error.
   */
  async function upsertRecord(opts: {
    domain: string;
    type: 'A' | 'AAAA' | 'CNAME';
    value: string;
    proxied?: boolean;
    ttl?: number;
  }): Promise<{ id: string; success: boolean }> {
    const zoneId = await getZoneId(opts.domain);
    const proxied = opts.proxied ?? true;
    const ttl = opts.ttl ?? (proxied ? 1 : 300);

    // Check for existing record with same name+type
    const existing = await listRecords({ type: opts.type, name: opts.domain });

    const body = {
      type: opts.type,
      name: opts.domain,
      content: opts.value,
      proxied,
      ttl,
    };

    if (existing.length > 0) {
      // Update existing record
      const recordId = existing[0].id;
      const resp = await cfFetch<DnsRecord>(`/zones/${zoneId}/dns_records/${recordId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      return { id: resp.result.id, success: true };
    }

    // Create new record
    const resp = await cfFetch<DnsRecord>(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { id: resp.result.id, success: true };
  }

  /**
   * Delete all DNS records in the zone matching the given domain name and
   * optional type.
   *
   * Resolves the list of matching records via `listRecords()`, then issues a
   * `DELETE` for each one. If no records match, the function returns without
   * error. When multiple records match (e.g. both an A and CNAME under the same
   * name), all are deleted unless `type` is provided to filter.
   *
   * @param domain - Fully-qualified domain name to delete records for.
   * @param type - Optional record type to restrict deletion (e.g. `'A'`).
   *   When omitted, all record types for `domain` are deleted.
   *
   * @throws {Error} If the zone cannot be resolved (see `getZoneId`).
   * @throws {Error} If the Cloudflare API returns an error during deletion.
   */
  async function deleteRecord(domain: string, type?: string): Promise<void> {
    const zoneId = await getZoneId(domain);
    const records = await listRecords({ name: domain, type });

    for (const record of records) {
      await cfFetch<{ id: string }>(`/zones/${zoneId}/dns_records/${record.id}`, {
        method: 'DELETE',
      });
    }
  }

  return { upsertRecord, deleteRecord, listRecords, resolveZoneId };
}
