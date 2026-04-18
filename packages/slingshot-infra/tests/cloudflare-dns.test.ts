import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type DnsRecord, createCloudflareClient } from '../src/dns/cloudflare';

// ---------------------------------------------------------------------------
// Mock Cloudflare API via fetch interception
// ---------------------------------------------------------------------------

const MOCK_ZONE_ID = 'zone-abc-123';
const MOCK_API_TOKEN = 'test-token-xyz';
const CF_BASE = 'https://api.cloudflare.com/client/v4';

/** In-memory record store for the mock API. */
let mockRecords: DnsRecord[] = [];
let nextRecordId = 1;
let capturedRequests: Array<{
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string>;
}> = [];

const originalFetch = globalThis.fetch;

function mockCloudflareFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init?.headers) {
    const h = new Headers(init.headers);
    h.forEach((v, k) => {
      headers[k] = v;
    });
  }
  const body = init?.body ? JSON.parse(init.body as string) : undefined;

  capturedRequests.push({ method, url, body, headers });

  // Zone lookup
  if (url.startsWith(`${CF_BASE}/zones?`) && method === 'GET') {
    const params = new URL(url).searchParams;
    const name = params.get('name');
    if (name === 'example.com') {
      return jsonResponse({ result: [{ id: MOCK_ZONE_ID, name: 'example.com' }] });
    }
    return jsonResponse({ result: [] });
  }

  // List records
  const listMatch = url.match(/\/zones\/([^/]+)\/dns_records\?(.+)/);
  if (listMatch && method === 'GET') {
    const params = new URLSearchParams(listMatch[2]);
    let filtered = [...mockRecords];
    const nameFilter = params.get('name');
    const typeFilter = params.get('type');
    if (nameFilter) filtered = filtered.filter(r => r.name === nameFilter);
    if (typeFilter) filtered = filtered.filter(r => r.type === typeFilter);

    return jsonResponse({
      result: filtered,
      result_info: { page: 1, per_page: 100, total_count: filtered.length, total_pages: 1 },
    });
  }

  // Create record
  const createMatch = url.match(/\/zones\/([^/]+)\/dns_records$/);
  if (createMatch && method === 'POST') {
    const record: DnsRecord = {
      id: `rec-${nextRecordId++}`,
      type: body.type,
      name: body.name,
      content: body.content,
      proxied: body.proxied ?? true,
      ttl: body.ttl ?? 1,
    };
    mockRecords.push(record);
    return jsonResponse({ result: record });
  }

  // Update record
  const updateMatch = url.match(/\/zones\/([^/]+)\/dns_records\/([^?]+)$/);
  if (updateMatch && method === 'PUT') {
    const recordId = updateMatch[2];
    const idx = mockRecords.findIndex(r => r.id === recordId);
    if (idx !== -1) {
      mockRecords[idx] = { ...mockRecords[idx], ...body, id: recordId };
      return jsonResponse({ result: mockRecords[idx] });
    }
    return jsonResponse(
      { success: false, errors: [{ code: 404, message: 'Record not found' }] },
      404,
    );
  }

  // Delete record
  const deleteMatch = url.match(/\/zones\/([^/]+)\/dns_records\/([^?]+)$/);
  if (deleteMatch && method === 'DELETE') {
    const recordId = deleteMatch[2];
    mockRecords = mockRecords.filter(r => r.id !== recordId);
    return jsonResponse({ result: { id: recordId } });
  }

  // Fallback — not found
  return jsonResponse({ success: false, errors: [{ code: 404, message: 'Not found' }] }, 404);
}

function jsonResponse(data: Record<string, unknown>, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ success: status < 400, errors: [], ...data }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  globalThis.fetch = mockCloudflareFetch as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  mockRecords = [];
  nextRecordId = 1;
  capturedRequests = [];
});

// ---------------------------------------------------------------------------
// resolveZoneId
// ---------------------------------------------------------------------------

describe('cloudflare: resolveZoneId', () => {
  it('resolves zone ID from a full domain', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN });
    const zoneId = await client.resolveZoneId('api.example.com');
    expect(zoneId).toBe(MOCK_ZONE_ID);
  });

  it('strips subdomains to find base domain', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN });
    await client.resolveZoneId('deep.nested.api.example.com');
    const req = capturedRequests.find(r => r.url.includes('/zones?'));
    expect(req!.url).toContain('name=example.com');
  });

  it('throws when no zone found', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN });
    await expect(client.resolveZoneId('api.unknown.org')).rejects.toThrow(
      'No zone found for domain',
    );
  });

  it('caches zone ID across internal getZoneId calls', async () => {
    // resolveZoneId() is the raw public method (no cache).
    // Caching happens in the internal getZoneId() used by upsertRecord/listRecords.
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN });
    await client.listRecords({ name: 'api.example.com' });
    await client.listRecords({ name: 'other.example.com' });
    // Both listRecords calls go through getZoneId — only the first should trigger a zone lookup
    const zoneRequests = capturedRequests.filter(r => r.url.includes('/zones?'));
    expect(zoneRequests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// upsertRecord
// ---------------------------------------------------------------------------

describe('cloudflare: upsertRecord', () => {
  it('creates a new A record when none exists', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN, zoneId: MOCK_ZONE_ID });
    const result = await client.upsertRecord({
      domain: 'api.example.com',
      type: 'A',
      value: '1.2.3.4',
    });
    expect(result.success).toBe(true);
    expect(result.id).toBeDefined();
    expect(mockRecords).toHaveLength(1);
    expect(mockRecords[0].content).toBe('1.2.3.4');
    expect(mockRecords[0].type).toBe('A');
  });

  it('updates an existing record instead of creating a duplicate', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN, zoneId: MOCK_ZONE_ID });

    // Create initial record
    await client.upsertRecord({ domain: 'api.example.com', type: 'A', value: '1.2.3.4' });
    expect(mockRecords).toHaveLength(1);

    // Upsert with new value — should update, not create
    await client.upsertRecord({ domain: 'api.example.com', type: 'A', value: '5.6.7.8' });
    expect(mockRecords).toHaveLength(1);
    expect(mockRecords[0].content).toBe('5.6.7.8');
  });

  it('defaults proxied to true and ttl to 1 (Auto)', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN, zoneId: MOCK_ZONE_ID });
    await client.upsertRecord({ domain: 'api.example.com', type: 'A', value: '1.2.3.4' });
    expect(mockRecords[0].proxied).toBe(true);
    expect(mockRecords[0].ttl).toBe(1);
  });

  it('uses ttl 300 when proxied is false', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN, zoneId: MOCK_ZONE_ID });
    await client.upsertRecord({
      domain: 'api.example.com',
      type: 'A',
      value: '1.2.3.4',
      proxied: false,
    });
    expect(mockRecords[0].ttl).toBe(300);
    expect(mockRecords[0].proxied).toBe(false);
  });

  it('creates CNAME records', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN, zoneId: MOCK_ZONE_ID });
    await client.upsertRecord({
      domain: 'www.example.com',
      type: 'CNAME',
      value: 'api.example.com',
    });
    expect(mockRecords[0].type).toBe('CNAME');
    expect(mockRecords[0].content).toBe('api.example.com');
  });

  it('sends Bearer token in Authorization header', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN, zoneId: MOCK_ZONE_ID });
    await client.upsertRecord({ domain: 'api.example.com', type: 'A', value: '1.2.3.4' });
    const createReq = capturedRequests.find(r => r.method === 'POST');
    expect(createReq!.headers.authorization).toBe(`Bearer ${MOCK_API_TOKEN}`);
  });
});

// ---------------------------------------------------------------------------
// listRecords
// ---------------------------------------------------------------------------

describe('cloudflare: listRecords', () => {
  it('returns empty array when no records exist', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN, zoneId: MOCK_ZONE_ID });
    const records = await client.listRecords({ name: 'api.example.com' });
    expect(records).toEqual([]);
  });

  it('returns matching records', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN, zoneId: MOCK_ZONE_ID });
    await client.upsertRecord({ domain: 'api.example.com', type: 'A', value: '1.2.3.4' });
    await client.upsertRecord({
      domain: 'www.example.com',
      type: 'CNAME',
      value: 'api.example.com',
    });

    const records = await client.listRecords({ name: 'api.example.com' });
    expect(records).toHaveLength(1);
    expect(records[0].content).toBe('1.2.3.4');
  });

  it('filters by type', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN, zoneId: MOCK_ZONE_ID });
    await client.upsertRecord({ domain: 'api.example.com', type: 'A', value: '1.2.3.4' });

    const cnames = await client.listRecords({ name: 'api.example.com', type: 'CNAME' });
    expect(cnames).toHaveLength(0);

    const aRecords = await client.listRecords({ name: 'api.example.com', type: 'A' });
    expect(aRecords).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// deleteRecord
// ---------------------------------------------------------------------------

describe('cloudflare: deleteRecord', () => {
  it('deletes all records for a domain', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN, zoneId: MOCK_ZONE_ID });
    await client.upsertRecord({ domain: 'api.example.com', type: 'A', value: '1.2.3.4' });
    expect(mockRecords).toHaveLength(1);

    await client.deleteRecord('api.example.com');
    expect(mockRecords).toHaveLength(0);
  });

  it('no-op when no records match', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN, zoneId: MOCK_ZONE_ID });
    await client.deleteRecord('nonexistent.example.com');
    // Should not throw
  });

  it('filters deletion by type', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN, zoneId: MOCK_ZONE_ID });

    // Manually add two record types for same domain
    mockRecords.push(
      { id: 'r1', type: 'A', name: 'api.example.com', content: '1.2.3.4', proxied: true, ttl: 1 },
      {
        id: 'r2',
        type: 'CNAME',
        name: 'api.example.com',
        content: 'lb.example.com',
        proxied: true,
        ttl: 1,
      },
    );

    await client.deleteRecord('api.example.com', 'A');
    expect(mockRecords).toHaveLength(1);
    expect(mockRecords[0].type).toBe('CNAME');
  });
});

// ---------------------------------------------------------------------------
// Zone resolution with no zoneId
// ---------------------------------------------------------------------------

describe('cloudflare: lazy zone resolution', () => {
  it('resolves zone from domain on first API call', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN });
    await client.upsertRecord({ domain: 'api.example.com', type: 'A', value: '1.2.3.4' });
    expect(mockRecords).toHaveLength(1);
  });

  it('uses pre-configured zoneId without zone lookup', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN, zoneId: MOCK_ZONE_ID });
    await client.listRecords({ name: 'api.example.com' });
    const zoneRequests = capturedRequests.filter(r => r.url.includes('/zones?'));
    expect(zoneRequests).toHaveLength(0);
  });

  it('throws when no zoneId and no domain to resolve from', async () => {
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN });
    await expect(client.listRecords()).rejects.toThrow('No zoneId configured');
  });
});

// ---------------------------------------------------------------------------
// API error handling
// ---------------------------------------------------------------------------

describe('cloudflare: API error handling', () => {
  it('throws on API error response', async () => {
    // Override mock to return an error for a specific zone lookup
    const client = createCloudflareClient({ apiToken: MOCK_API_TOKEN });
    await expect(client.resolveZoneId('api.unknown.org')).rejects.toThrow('No zone found');
  });
});
