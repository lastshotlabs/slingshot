import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createCloudflareClient } from '../../../packages/slingshot-infra/src/dns/cloudflare';
import { createDnsManager } from '../../../packages/slingshot-infra/src/dns/manager';

// ---------- helpers ----------

interface MockRoute {
  method: string;
  path: RegExp;
  handler: (url: URL, body?: unknown) => unknown;
}

function createMockFetch(routes: MockRoute[]) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString(),
    );
    const method = init?.method ?? 'GET';

    for (const route of routes) {
      if (route.method === method && route.path.test(url.pathname + url.search)) {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        const result = route.handler(url, body);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(
      JSON.stringify({
        success: false,
        errors: [{ code: 404, message: 'Not found' }],
        result: null,
      }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  };
}

// ---------- Cloudflare client tests ----------

describe('createCloudflareClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('upsert creates record when none exists', async () => {
    let createdBody: unknown = null;

    globalThis.fetch = createMockFetch([
      {
        method: 'GET',
        path: /\/zones\/zone123\/dns_records\?.*type=A.*name=app\.example\.com/,
        handler: () => ({
          success: true,
          errors: [],
          result: [],
          result_info: { page: 1, per_page: 100, total_count: 0, total_pages: 1 },
        }),
      },
      {
        method: 'POST',
        path: /\/zones\/zone123\/dns_records$/,
        handler: (_url, body) => {
          createdBody = body;
          return {
            success: true,
            errors: [],
            result: {
              id: 'rec-new',
              type: 'A',
              name: 'app.example.com',
              content: '1.2.3.4',
              proxied: true,
              ttl: 1,
            },
          };
        },
      },
    ]) as typeof fetch;

    const client = createCloudflareClient({ apiToken: 'test-token', zoneId: 'zone123' });
    const result = await client.upsertRecord({
      domain: 'app.example.com',
      type: 'A',
      value: '1.2.3.4',
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe('rec-new');
    expect((createdBody as Record<string, unknown>).type).toBe('A');
    expect((createdBody as Record<string, unknown>).name).toBe('app.example.com');
    expect((createdBody as Record<string, unknown>).content).toBe('1.2.3.4');
  });

  it('upsert updates record when one exists', async () => {
    let updatedBody: unknown = null;

    globalThis.fetch = createMockFetch([
      {
        method: 'GET',
        path: /\/zones\/zone123\/dns_records\?.*type=A.*name=app\.example\.com/,
        handler: () => ({
          success: true,
          errors: [],
          result: [
            {
              id: 'rec-existing',
              type: 'A',
              name: 'app.example.com',
              content: '0.0.0.0',
              proxied: false,
              ttl: 300,
            },
          ],
          result_info: { page: 1, per_page: 100, total_count: 1, total_pages: 1 },
        }),
      },
      {
        method: 'PUT',
        path: /\/zones\/zone123\/dns_records\/rec-existing$/,
        handler: (_url, body) => {
          updatedBody = body;
          return {
            success: true,
            errors: [],
            result: {
              id: 'rec-existing',
              type: 'A',
              name: 'app.example.com',
              content: '1.2.3.4',
              proxied: true,
              ttl: 1,
            },
          };
        },
      },
    ]) as typeof fetch;

    const client = createCloudflareClient({ apiToken: 'test-token', zoneId: 'zone123' });
    const result = await client.upsertRecord({
      domain: 'app.example.com',
      type: 'A',
      value: '1.2.3.4',
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe('rec-existing');
    expect((updatedBody as Record<string, unknown>).content).toBe('1.2.3.4');
  });

  it('delete removes record', async () => {
    let deleteCalledWith: string | null = null;

    globalThis.fetch = createMockFetch([
      {
        method: 'GET',
        path: /\/zones\/zone123\/dns_records\?/,
        handler: () => ({
          success: true,
          errors: [],
          result: [
            {
              id: 'rec-del',
              type: 'A',
              name: 'app.example.com',
              content: '1.2.3.4',
              proxied: true,
              ttl: 1,
            },
          ],
          result_info: { page: 1, per_page: 100, total_count: 1, total_pages: 1 },
        }),
      },
      {
        method: 'DELETE',
        path: /\/zones\/zone123\/dns_records\/(.*)/,
        handler: url => {
          deleteCalledWith = url.pathname.split('/').pop()!;
          return { success: true, errors: [], result: { id: deleteCalledWith } };
        },
      },
    ]) as typeof fetch;

    const client = createCloudflareClient({ apiToken: 'test-token', zoneId: 'zone123' });
    await client.deleteRecord('app.example.com');

    expect(deleteCalledWith!).toBe('rec-del');
  });

  it('resolves zone ID from domain', async () => {
    globalThis.fetch = createMockFetch([
      {
        method: 'GET',
        path: /\/zones\?name=example\.com/,
        handler: () => ({
          success: true,
          errors: [],
          result: [{ id: 'zone-resolved', name: 'example.com' }],
        }),
      },
    ]) as typeof fetch;

    const client = createCloudflareClient({ apiToken: 'test-token' });
    const zoneId = await client.resolveZoneId('api.example.com');

    expect(zoneId).toBe('zone-resolved');
  });

  it('defaults proxied to true', async () => {
    let createdBody: unknown = null;

    globalThis.fetch = createMockFetch([
      {
        method: 'GET',
        path: /\/zones\/zone123\/dns_records\?/,
        handler: () => ({
          success: true,
          errors: [],
          result: [],
          result_info: { page: 1, per_page: 100, total_count: 0, total_pages: 1 },
        }),
      },
      {
        method: 'POST',
        path: /\/zones\/zone123\/dns_records$/,
        handler: (_url, body) => {
          createdBody = body;
          return {
            success: true,
            errors: [],
            result: {
              id: 'rec-1',
              type: 'A',
              name: 'app.example.com',
              content: '1.2.3.4',
              proxied: true,
              ttl: 1,
            },
          };
        },
      },
    ]) as typeof fetch;

    const client = createCloudflareClient({ apiToken: 'test-token', zoneId: 'zone123' });
    await client.upsertRecord({ domain: 'app.example.com', type: 'A', value: '1.2.3.4' });

    expect((createdBody as Record<string, unknown>).proxied).toBe(true);
  });
});

// ---------- DnsManager tests ----------

describe('createDnsManager', () => {
  it('manual provider is no-op (logs instead of calling APIs)', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));

    try {
      const manager = createDnsManager({ provider: 'manual' });
      await manager.ensureRecords({ domain: 'app.example.com', target: '1.2.3.4' });
      expect(logs.some(l => l.includes('Please create'))).toBe(true);
      expect(logs.some(l => l.includes('app.example.com'))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  it('route53 provider throws not-implemented error', () => {
    const manager = createDnsManager({ provider: 'route53' });
    expect(() => manager.ensureRecords({ domain: 'x', target: 'y' })).toThrow(
      'Route53 provider is not yet implemented',
    );
  });

  it('cloudflare provider requires apiToken', () => {
    expect(() => createDnsManager({ provider: 'cloudflare' })).toThrow('requires an apiToken');
  });

  it('DnsManager.ensureRecords calls client correctly for IP targets', async () => {
    let upsertCall: Record<string, unknown> | null = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = createMockFetch([
      {
        method: 'GET',
        path: /\/zones\/z1\/dns_records\?/,
        handler: () => ({
          success: true,
          errors: [],
          result: [],
          result_info: { page: 1, per_page: 100, total_count: 0, total_pages: 1 },
        }),
      },
      {
        method: 'POST',
        path: /\/zones\/z1\/dns_records$/,
        handler: (_url, body) => {
          upsertCall = body as Record<string, unknown>;
          return {
            success: true,
            errors: [],
            result: {
              id: 'r1',
              type: 'A',
              name: 'app.example.com',
              content: '10.0.0.1',
              proxied: true,
              ttl: 1,
            },
          };
        },
      },
    ]) as typeof fetch;

    try {
      const manager = createDnsManager({
        provider: 'cloudflare',
        apiToken: 'tok',
        zoneId: 'z1',
      });
      await manager.ensureRecords({ domain: 'app.example.com', target: '10.0.0.1' });

      expect(upsertCall).not.toBeNull();
      expect(upsertCall!.type).toBe('A');
      expect(upsertCall!.content).toBe('10.0.0.1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('DnsManager.ensureRecords uses CNAME for hostname targets', async () => {
    let upsertCall: Record<string, unknown> | null = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = createMockFetch([
      {
        method: 'GET',
        path: /\/zones\/z1\/dns_records\?/,
        handler: () => ({
          success: true,
          errors: [],
          result: [],
          result_info: { page: 1, per_page: 100, total_count: 0, total_pages: 1 },
        }),
      },
      {
        method: 'POST',
        path: /\/zones\/z1\/dns_records$/,
        handler: (_url, body) => {
          upsertCall = body as Record<string, unknown>;
          return {
            success: true,
            errors: [],
            result: {
              id: 'r2',
              type: 'CNAME',
              name: 'app.example.com',
              content: 'lb.example.com',
              proxied: true,
              ttl: 1,
            },
          };
        },
      },
    ]) as typeof fetch;

    try {
      const manager = createDnsManager({
        provider: 'cloudflare',
        apiToken: 'tok',
        zoneId: 'z1',
      });
      await manager.ensureRecords({ domain: 'app.example.com', target: 'lb.example.com' });

      expect(upsertCall).not.toBeNull();
      expect(upsertCall!.type).toBe('CNAME');
      expect(upsertCall!.content).toBe('lb.example.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
