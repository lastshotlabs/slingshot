import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { AuditLogEntry, AuditLogProvider } from '@lastshotlabs/slingshot-core';
import { createMemoryManagedUserProvider } from '../../src/providers/memoryAccess';
import { createAdminRouter } from '../../src/routes/admin';
import type { AdminEnv } from '../../src/types/env';

// ---------------------------------------------------------------------------
// In-memory audit log that strictly honours the requestTenantId contract.
//
// This intentionally mirrors the production memory adapter's behaviour so the
// integration test verifies the framework + adapter contract end-to-end:
//   1. Routes pass `principal.tenantId` to `getLogs`.
//   2. The adapter applies it as a hard equality filter.
// ---------------------------------------------------------------------------

interface RecordingAuditLog extends AuditLogProvider {
  readonly entries: readonly AuditLogEntry[];
  /** Captured `getLogs` calls so we can assert the route always passes tenantId. */
  readonly calls: ReadonlyArray<{ requestTenantId: string | undefined; userId?: string }>;
  seed(entry: AuditLogEntry): void;
}

function createTenantStrictAuditLog(): RecordingAuditLog {
  const entries: AuditLogEntry[] = [];
  const calls: Array<{ requestTenantId: string | undefined; userId?: string }> = [];

  return {
    get entries() {
      return entries;
    },
    get calls() {
      return calls;
    },
    seed(entry) {
      entries.push(entry);
    },
    logEntry(entry) {
      entries.push(entry);
      return Promise.resolve();
    },
    getLogs(query) {
      calls.push({ requestTenantId: query.requestTenantId, userId: query.userId });
      const filtered = entries.filter(entry => {
        if (query.requestTenantId !== undefined && entry.requestTenantId !== query.requestTenantId)
          return false;
        if (query.userId !== undefined && entry.userId !== query.userId) return false;
        return true;
      });
      return Promise.resolve({ items: filtered });
    },
  };
}

function buildApp(tenantId: string, auditLog: AuditLogProvider) {
  const managedUserProvider = createMemoryManagedUserProvider();
  const app = new Hono<AdminEnv>();
  app.use('*', async (c, next) => {
    c.set('adminPrincipal', {
      subject: `admin-${tenantId}`,
      provider: 'memory',
      tenantId,
    });
    await next();
  });
  app.route(
    '/',
    createAdminRouter({
      managedUserProvider,
      bus: createInProcessAdapter(),
      evaluator: { can: async () => true },
      auditLog,
    }),
  );
  return { app, managedUserProvider };
}

function makeEntry(overrides: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    id: overrides.id ?? `entry-${Math.random().toString(36).slice(2, 10)}`,
    userId: overrides.userId ?? null,
    sessionId: overrides.sessionId ?? null,
    requestTenantId: overrides.requestTenantId ?? null,
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/things',
    status: overrides.status ?? 200,
    ip: overrides.ip ?? null,
    userAgent: overrides.userAgent ?? null,
    action: overrides.action,
    resource: overrides.resource,
    resourceId: overrides.resourceId,
    meta: overrides.meta,
    requestId: overrides.requestId,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

let auditLog: RecordingAuditLog;

beforeEach(() => {
  auditLog = createTenantStrictAuditLog();
});

afterEach(() => {
  // Reset between tests; created fresh in beforeEach but defensive cleanup.
});

describe('audit log tenant isolation', () => {
  test('GET /audit-log only returns entries scoped to the principal tenant', async () => {
    auditLog.seed(makeEntry({ id: 'a-1', requestTenantId: 'tenant-a', path: '/a/1' }));
    auditLog.seed(makeEntry({ id: 'a-2', requestTenantId: 'tenant-a', path: '/a/2' }));
    auditLog.seed(makeEntry({ id: 'b-1', requestTenantId: 'tenant-b', path: '/b/secret' }));

    const tenantA = buildApp('tenant-a', auditLog);
    const responseA = await tenantA.app.request('/audit-log');
    expect(responseA.status).toBe(200);
    const bodyA = (await responseA.json()) as { items: AuditLogEntry[] };
    const idsA = bodyA.items.map(item => item.id).sort();
    expect(idsA).toEqual(['a-1', 'a-2']);
    expect(bodyA.items.some(item => item.requestTenantId === 'tenant-b')).toBe(false);

    const tenantB = buildApp('tenant-b', auditLog);
    const responseB = await tenantB.app.request('/audit-log');
    expect(responseB.status).toBe(200);
    const bodyB = (await responseB.json()) as { items: AuditLogEntry[] };
    expect(bodyB.items.map(item => item.id)).toEqual(['b-1']);
    expect(bodyB.items.some(item => item.requestTenantId === 'tenant-a')).toBe(false);

    // Both routes must have forwarded the principal tenant — never `undefined`.
    expect(auditLog.calls.every(call => call.requestTenantId !== undefined)).toBe(true);
  });

  test('GET /users/:userId/audit-log refuses to read another tenant user', async () => {
    auditLog.seed(
      makeEntry({ id: 'b-1', userId: 'user-b', requestTenantId: 'tenant-b', path: '/b/p1' }),
    );
    auditLog.seed(
      makeEntry({ id: 'a-1', userId: 'user-a', requestTenantId: 'tenant-a', path: '/a/p1' }),
    );

    // tenant-a tries to read tenant-b's user audit log.
    const { app, managedUserProvider } = buildApp('tenant-a', auditLog);
    managedUserProvider.seedUser({
      id: 'user-a',
      tenantId: 'tenant-a',
      email: 'a@example.com',
      provider: 'memory',
      status: 'active',
    });
    managedUserProvider.seedUser({
      id: 'user-b',
      tenantId: 'tenant-b',
      email: 'b@example.com',
      provider: 'memory',
      status: 'active',
    });

    const crossTenant = await app.request('/users/user-b/audit-log');
    // The user lookup is scoped by tenant — tenant-a cannot resolve user-b at all,
    // so the route returns 404 BEFORE getLogs() is ever invoked. This is the
    // first line of defence; the requestTenantId filter is the second.
    expect(crossTenant.status).toBe(404);
  });

  test('GET /users/:userId/audit-log enforces tenant filter on the adapter call', async () => {
    auditLog.seed(
      makeEntry({ id: 'a-1', userId: 'user-a', requestTenantId: 'tenant-a', path: '/a/p1' }),
    );
    auditLog.seed(
      makeEntry({ id: 'a-2', userId: 'user-a', requestTenantId: 'tenant-a', path: '/a/p2' }),
    );
    // A poisoned entry: same userId but in a different tenant. If the adapter
    // ignored requestTenantId we would see this row leak into the response.
    auditLog.seed(
      makeEntry({ id: 'leak', userId: 'user-a', requestTenantId: 'tenant-b', path: '/b/leak' }),
    );

    const { app, managedUserProvider } = buildApp('tenant-a', auditLog);
    managedUserProvider.seedUser({
      id: 'user-a',
      tenantId: 'tenant-a',
      email: 'a@example.com',
      provider: 'memory',
      status: 'active',
    });

    const response = await app.request('/users/user-a/audit-log');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: AuditLogEntry[] };
    expect(body.items.map(item => item.id).sort()).toEqual(['a-1', 'a-2']);
    expect(body.items.some(item => item.id === 'leak')).toBe(false);

    // Adapter call must have included the tenant filter.
    const lastCall = auditLog.calls[auditLog.calls.length - 1];
    expect(lastCall?.requestTenantId).toBe('tenant-a');
    expect(lastCall?.userId).toBe('user-a');
  });
});
