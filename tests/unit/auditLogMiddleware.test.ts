/**
 * Tests for src/framework/middleware/auditLog.ts (lines 57-96)
 */
import { describe, expect, mock, spyOn, test } from 'bun:test';
import type { Actor, AuditLogEntry, AuditLogProvider } from '@lastshotlabs/slingshot-core';
import { auditLog } from '../../src/framework/middleware/auditLog';

function makeMockProvider(): AuditLogProvider & { entries: AuditLogEntry[] } {
  const entries: AuditLogEntry[] = [];
  return {
    entries,
    async logEntry(entry: AuditLogEntry) {
      entries.push(entry);
    },
    async getLogs() {
      return { items: entries };
    },
  };
}

function makeContext(overrides: {
  method?: string;
  path?: string;
  status?: number;
  headers?: Record<string, string>;
  contextValues?: Record<string, unknown>;
}) {
  const {
    method = 'POST',
    path = '/api/test',
    status = 200,
    headers = {},
    contextValues = {},
  } = overrides;

  const store = new Map<string, unknown>(Object.entries(contextValues));

  return {
    req: {
      method,
      path,
      header: (name: string) => headers[name.toLowerCase()] ?? undefined,
      raw: new Request('http://localhost' + path, { method }),
    },
    res: { status },
    get: (key: string) => store.get(key) ?? undefined,
    set: (key: string, value: unknown) => store.set(key, value),
    json: mock(() => new Response()),
    header: mock(() => {}),
  } as unknown as import('hono').Context<import('@lastshotlabs/slingshot-core').AppEnv>;
}

describe('auditLog middleware', () => {
  test('calls next() and logs entry for POST request', async () => {
    const provider = makeMockProvider();
    const middleware = auditLog({ store: 'memory', provider });

    const ctx = makeContext({ method: 'POST', path: '/api/users', status: 201 });
    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    // Fire-and-forget — wait a tick for the promise to flush
    await new Promise(r => setTimeout(r, 0));
    expect(provider.entries.length).toBe(1);
    expect(provider.entries[0].method).toBe('POST');
    expect(provider.entries[0].path).toBe('/api/users');
    expect(provider.entries[0].status).toBe(201);
  });

  test('skips logging for excluded methods', async () => {
    const provider = makeMockProvider();
    const middleware = auditLog({
      store: 'memory',
      provider,
      exclude: { methods: ['GET', 'HEAD'] },
    });

    const ctx = makeContext({ method: 'GET', path: '/api/data', status: 200 });
    await middleware(ctx, async () => {});

    await new Promise(r => setTimeout(r, 0));
    expect(provider.entries.length).toBe(0);
  });

  test('logs for non-excluded methods when exclude.methods is set', async () => {
    const provider = makeMockProvider();
    const middleware = auditLog({ store: 'memory', provider, exclude: { methods: ['GET'] } });

    const ctx = makeContext({ method: 'DELETE', path: '/api/item/1', status: 204 });
    await middleware(ctx, async () => {});

    await new Promise(r => setTimeout(r, 0));
    expect(provider.entries.length).toBe(1);
  });

  test('skips logging for excluded string paths', async () => {
    const provider = makeMockProvider();
    const middleware = auditLog({
      store: 'memory',
      provider,
      exclude: { paths: ['/health', '/metrics'] },
    });

    const ctx = makeContext({ method: 'GET', path: '/health', status: 200 });
    await middleware(ctx, async () => {});

    await new Promise(r => setTimeout(r, 0));
    expect(provider.entries.length).toBe(0);
  });

  test('skips logging for excluded regex paths', async () => {
    const provider = makeMockProvider();
    const middleware = auditLog({ store: 'memory', provider, exclude: { paths: [/^\/docs/] } });

    const ctx = makeContext({ method: 'GET', path: '/docs/api', status: 200 });
    await middleware(ctx, async () => {});

    await new Promise(r => setTimeout(r, 0));
    expect(provider.entries.length).toBe(0);
  });

  test('logs when path does NOT match exclude regex', async () => {
    const provider = makeMockProvider();
    const middleware = auditLog({ store: 'memory', provider, exclude: { paths: [/^\/docs/] } });

    const ctx = makeContext({ method: 'POST', path: '/api/submit', status: 200 });
    await middleware(ctx, async () => {});

    await new Promise(r => setTimeout(r, 0));
    expect(provider.entries.length).toBe(1);
  });

  test('entry includes userId + sessionId from actor and requestTenantId from request context', async () => {
    const provider = makeMockProvider();
    const middleware = auditLog({ store: 'memory', provider });

    const ctx = makeContext({
      method: 'POST',
      path: '/api/action',
      status: 200,
      contextValues: {
        actor: {
          id: 'user-123',
          kind: 'user',
          tenantId: 'actor-tenant', // identity-bound, must NOT appear on the entry
          sessionId: 'sess-456',
          roles: null,
          claims: {},
        } satisfies Actor,
        tenantId: 'tenant-789', // request-scoped, this is what the entry records
      },
    });
    await middleware(ctx, async () => {});

    await new Promise(r => setTimeout(r, 0));
    expect(provider.entries[0].userId).toBe('user-123');
    expect(provider.entries[0].sessionId).toBe('sess-456');
    expect(provider.entries[0].requestTenantId).toBe('tenant-789');
  });

  test('entry includes user-agent header', async () => {
    const provider = makeMockProvider();
    const middleware = auditLog({ store: 'memory', provider });

    const ctx = makeContext({
      method: 'POST',
      path: '/api/action',
      status: 200,
      headers: { 'user-agent': 'TestAgent/1.0' },
    });
    await middleware(ctx, async () => {});

    await new Promise(r => setTimeout(r, 0));
    expect(provider.entries[0].userAgent).toBe('TestAgent/1.0');
  });

  test('onEntry hook is called and can modify the entry', async () => {
    const provider = makeMockProvider();
    const middleware = auditLog({
      store: 'memory',
      provider,
      onEntry: entry => ({
        ...entry,
        action: 'custom.action',
        resource: 'MyResource',
      }),
    });

    const ctx = makeContext({ method: 'POST', path: '/api/resource', status: 200 });
    await middleware(ctx, async () => {});

    await new Promise(r => setTimeout(r, 0));
    expect(provider.entries[0].action).toBe('custom.action');
    expect(provider.entries[0].resource).toBe('MyResource');
  });

  test('onEntry hook throwing logs error but still writes original entry', async () => {
    const provider = makeMockProvider();
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    const middleware = auditLog({
      store: 'memory',
      provider,
      onEntry: () => {
        throw new Error('hook failed');
      },
    });

    const ctx = makeContext({ method: 'POST', path: '/api/resource', status: 200 });
    await middleware(ctx, async () => {});

    await new Promise(r => setTimeout(r, 0));
    // The original entry should still be written despite hook error
    expect(provider.entries.length).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[auditLog] onEntry hook threw:'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  test('async onEntry hook is awaited', async () => {
    const provider = makeMockProvider();
    const middleware = auditLog({
      store: 'memory',
      provider,
      onEntry: async entry => {
        await new Promise(r => setTimeout(r, 0));
        return { ...entry, resourceId: 'async-resource-id' };
      },
    });

    const ctx = makeContext({ method: 'POST', path: '/api/resource', status: 200 });
    await middleware(ctx, async () => {});

    await new Promise(r => setTimeout(r, 0));
    expect(provider.entries[0].resourceId).toBe('async-resource-id');
  });

  test('write failures are swallowed (fire-and-forget)', async () => {
    const failingProvider: AuditLogProvider = {
      async logEntry() {
        throw new Error('DB write failed');
      },
      async getLogs() {
        return { items: [] };
      },
    };

    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    const middleware = auditLog({ store: 'memory', provider: failingProvider });
    const ctx = makeContext({ method: 'POST', path: '/api/test', status: 200 });

    // Should not throw
    await expect(middleware(ctx, async () => {})).resolves.toBeUndefined();

    await new Promise(r => setTimeout(r, 0));
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[auditLog] write failed:'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  test('entry has a valid UUID id', async () => {
    const provider = makeMockProvider();
    const middleware = auditLog({ store: 'memory', provider });

    const ctx = makeContext({ method: 'POST', path: '/test', status: 200 });
    await middleware(ctx, async () => {});

    await new Promise(r => setTimeout(r, 0));
    expect(provider.entries[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test('entry has a valid ISO createdAt timestamp', async () => {
    const provider = makeMockProvider();
    const middleware = auditLog({ store: 'memory', provider });

    const ctx = makeContext({ method: 'POST', path: '/test', status: 200 });
    await middleware(ctx, async () => {});

    await new Promise(r => setTimeout(r, 0));
    expect(() => new Date(provider.entries[0].createdAt)).not.toThrow();
    expect(new Date(provider.entries[0].createdAt).getTime()).toBeGreaterThan(0);
  });

  test('userId defaults to null when actor is anonymous', async () => {
    const provider = makeMockProvider();
    const middleware = auditLog({ store: 'memory', provider });

    const ctx = makeContext({ method: 'POST', path: '/test', status: 200 });
    await middleware(ctx, async () => {});

    await new Promise(r => setTimeout(r, 0));
    expect(provider.entries[0].userId).toBeNull();
  });
});
