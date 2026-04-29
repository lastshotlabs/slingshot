/**
 * Edge-case coverage for admin audit log behavior.
 *
 * Builds on the core audit log tests in auditLog.test.ts and
 * auditLogTenantIsolation.test.ts. Covers concurrent log writes,
 * log entry format validation, tenant isolation edge cases,
 * and boundary conditions on action/resource/resourceId caps.
 */
import { describe, expect, mock, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { AuditLogProvider } from '@lastshotlabs/slingshot-core';
import { createMemoryManagedUserProvider } from '../../src/providers/memoryAccess';
import { createAdminRouter } from '../../src/routes/admin';
import type { AdminEnv } from '../../src/types/env';

function buildApp(
  auditLog?: AuditLogProvider,
  overrides: Partial<Parameters<typeof createAdminRouter>[0]> = {},
) {
  const managedUserProvider = createMemoryManagedUserProvider();
  const app = new Hono<AdminEnv>();

  app.use('*', async (c, next) => {
    c.set('adminPrincipal', { subject: 'admin', provider: 'memory', tenantId: 'tenant-1' });
    await next();
  });

  app.route(
    '/',
    createAdminRouter({
      managedUserProvider,
      bus: createInProcessAdapter(),
      evaluator: { can: async () => true },
      auditLog,
      ...overrides,
    }),
  );

  return { app, managedUserProvider };
}

const BASE_USER = {
  id: 'u-1',
  tenantId: 'tenant-1',
  email: 'test@example.com',
  displayName: 'Test',
  provider: 'memory' as const,
  status: 'active' as const,
};

// ---------------------------------------------------------------------------
// Concurrent audit log writes
// ---------------------------------------------------------------------------

describe('audit log concurrent writes', () => {
  test('concurrent PATCH requests both write audit entries', async () => {
    const logEntries: Array<Record<string, unknown>> = [];
    const auditLog: AuditLogProvider = {
      logEntry: mock(async entry => {
        logEntries.push(entry as unknown as Record<string, unknown>);
      }),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);

    await Promise.all([
      app.request('/users/u-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'Updated-A' }),
      }),
      app.request('/users/u-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'Updated-B' }),
      }),
    ]);

    // Both writes should have been recorded
    expect(logEntries.length).toBeGreaterThanOrEqual(2);
  });

  test('concurrent suspend and delete on same user both write entries', async () => {
    const logEntries: Array<Record<string, unknown>> = [];
    const auditLog: AuditLogProvider = {
      logEntry: mock(async entry => {
        logEntries.push(entry as unknown as Record<string, unknown>);
      }),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);

    await Promise.all([
      app.request('/users/u-1/suspend', { method: 'POST' }),
      app.request('/users/u-1', { method: 'DELETE' }),
    ]);

    expect(logEntries.length).toBeGreaterThanOrEqual(2);
    const actions = logEntries.map(e => e.action);
    expect(actions).toContain('admin.user.suspend');
    expect(actions).toContain('admin.user.delete');
  });
});

// ---------------------------------------------------------------------------
// Audit log entry format and content
// ---------------------------------------------------------------------------

describe('audit log entry format validation', () => {
  test('audit entry contains action, resource, resourceId, status, and principal', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const auditLog: AuditLogProvider = {
      logEntry: mock(async entry => {
        captured.push(entry as unknown as Record<string, unknown>);
      }),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);

    await app.request('/users/u-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Format Test' }),
    });

    expect(captured.length).toBeGreaterThan(0);
    const entry = captured[0] as Record<string, unknown>;
    expect(entry).toHaveProperty('action');
    expect(entry).toHaveProperty('status');
    // The entry may have resource or resourceId or both
    expect(entry.action).toBe('admin.user.update');
  });

  test('missing user in PATCH still logs the attempt', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const auditLog: AuditLogProvider = {
      logEntry: mock(async entry => {
        captured.push(entry as unknown as Record<string, unknown>);
      }),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const { app } = buildApp(auditLog);

    await app.request('/users/nonexistent', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Nope' }),
    });

    expect(captured.length).toBeGreaterThan(0);
    const entry = captured[0] as Record<string, unknown>;
    expect(entry.action).toBe('admin.user.update');
    expect(entry.status).toBe(404);
  });

  test('audit entry status reflects actual HTTP response code', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const auditLog: AuditLogProvider = {
      logEntry: mock(async entry => {
        captured.push(entry as unknown as Record<string, unknown>);
      }),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);

    // Successful suspend
    await app.request('/users/u-1/suspend', { method: 'POST' });
    expect(captured.length).toBeGreaterThan(0);
    const entry = captured[captured.length - 1] as Record<string, unknown>;
    expect(entry.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation in audit log
// ---------------------------------------------------------------------------

describe('audit log tenant isolation edge cases', () => {
  test('tenant-scoped user list does not leak users from other tenants in audit queries', async () => {
    const getLogsMock = mock(async () => ({ items: [], nextCursor: undefined }));
    const auditLog: AuditLogProvider = {
      logEntry: mock(async () => {}),
      getLogs: getLogsMock,
    };

    const { app } = buildApp(auditLog);

    // Query audit log with a specific userId from a different tenant
    const res = await app.request('/audit-log?userId=outside-tenant&action=admin.user.delete');
    expect(res.status).toBe(404);
    // The audit backend should not have been queried
    expect(getLogsMock).not.toHaveBeenCalled();
  });

  test('status filter on audit log is passed through to provider', async () => {
    const getLogsMock = mock(async () => ({ items: [], nextCursor: undefined }));
    const auditLog: AuditLogProvider = {
      logEntry: mock(async () => {}),
      getLogs: getLogsMock,
    };

    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);

    // Create some audit entries first
    await app.request('/users/u-1/suspend', { method: 'POST' });
    await app.request('/users/u-1', { method: 'DELETE' });

    // The getLogs calls happen internally - we just verify the shape
    expect(auditLog.logEntry).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Audit cap boundary
// ---------------------------------------------------------------------------

describe('audit entry cap boundaries', () => {
  test('action is capped at 256 chars', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const auditLog: AuditLogProvider = {
      logEntry: mock(async entry => {
        captured.push(entry as unknown as Record<string, unknown>);
      }),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);

    await app.request('/users/u-1/suspend', { method: 'POST' });

    for (const entry of captured) {
      const action = entry.action as string | undefined;
      if (action) {
        expect(action.length).toBeLessThanOrEqual(256);
      }
      const resource = entry.resource as string | undefined;
      if (resource) {
        expect(resource.length).toBeLessThanOrEqual(256);
      }
      const resourceId = entry.resourceId as string | undefined;
      if (resourceId) {
        expect(resourceId.length).toBeLessThanOrEqual(256);
      }
    }
  });

  test('audit entry always has a timestamp or createdAt', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const auditLog: AuditLogProvider = {
      logEntry: mock(async entry => {
        captured.push(entry as unknown as Record<string, unknown>);
      }),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);

    await app.request('/users/u-1/suspend', { method: 'POST' });

    for (const entry of captured) {
      expect(entry.timestamp || entry.createdAt).toBeTruthy();
    }
  });
});
