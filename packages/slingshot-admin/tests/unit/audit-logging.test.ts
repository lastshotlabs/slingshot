import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type {
  PermissionEvaluator,
  PermissionRegistry,
  PermissionsAdapter,
} from '@lastshotlabs/slingshot-core';
import { createConsoleAuditLogger, createMemoryAuditLogger } from '../../src/lib/auditLogger';
import type { AdminAuditEvent, AdminAuditLogger } from '../../src/lib/auditLogger';
import { createMemoryManagedUserProvider } from '../../src/providers/memoryAccess';
import { createAdminRouter } from '../../src/routes/admin';
import { createMailRouter } from '../../src/routes/mail';
import { createPermissionsRouter } from '../../src/routes/permissions';
import type { AdminEnv } from '../../src/types/env';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_USER = {
  id: 'u-1',
  tenantId: 'tenant-1',
  email: 'test@example.com',
  displayName: 'Test',
  provider: 'memory' as const,
  status: 'active' as const,
};

const ALWAYS_ALLOW_EVALUATOR: PermissionEvaluator = {
  can: async () => true,
};

const NULL_LOGGER = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  trace: mock(() => {}),
};

function buildAdminApp(auditLogger?: AdminAuditLogger) {
  const managedUserProvider = createMemoryManagedUserProvider();
  const memoryAudit = auditLogger ?? createMemoryAuditLogger();
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
      evaluator: ALWAYS_ALLOW_EVALUATOR,
      auditLogger: memoryAudit,
      logger: NULL_LOGGER as Parameters<typeof createAdminRouter>[0]['logger'],
    }),
  );

  return { app, managedUserProvider, auditLogger: memoryAudit };
}

interface BuildPermissionsAppOptions {
  auditLogger?: AdminAuditLogger;
}

function buildPermissionsApp(opts: BuildPermissionsAppOptions = {}) {
  const memoryAudit = opts.auditLogger ?? createMemoryAuditLogger();
  const app = new Hono<AdminEnv>();

  app.use('*', async (c, next) => {
    // Use undefined tenantId so tests can create grants without tenant scope
    // restrictions. Individual tests can override via middleware if needed.
    c.set('adminPrincipal', { subject: 'admin', provider: 'memory', tenantId: undefined });
    await next();
  });

  const adapter: PermissionsAdapter = {
    createGrant: mock(async input => 'grant-1'),
    revokeGrant: mock(async (_grantId, _by, _tenantId?) => true),
    getGrantsForSubject: mock(async () => []),
    listGrantsOnResource: mock(async () => []),
  };

  const registry: PermissionRegistry = {
    getDefinition: mock(async () => null),
    listResourceTypes: mock(() => [
      {
        resourceType: 'admin:user',
        actions: ['read', 'write'],
        roles: { admin: ['read', 'write'] },
      },
    ]),
  };

  app.route(
    '/permissions',
    createPermissionsRouter({
      evaluator: ALWAYS_ALLOW_EVALUATOR,
      adapter,
      registry,
      auditLogger: memoryAudit,
    }),
  );

  return { app, adapter, registry, auditLogger: memoryAudit };
}

function buildMailApp(auditLogger?: AdminAuditLogger) {
  const memoryAudit = auditLogger ?? createMemoryAuditLogger();
  const app = new Hono<AdminEnv>();

  app.use('*', async (c, next) => {
    c.set('adminPrincipal', { subject: 'admin', provider: 'memory', tenantId: 'tenant-1' });
    await next();
  });

  // Mount at / because the mail router registers paths like /mail/templates
  // (they include the /mail/ prefix already).
  app.route(
    '/',
    createMailRouter({
      renderer: {
        name: 'test-renderer',
        render: mock(async (_name, _data) => ({
          subject: 'Test Subject',
          html: '<p>Hello</p>',
          text: 'Hello',
        })),
        listTemplates: mock(async () => ['welcome', 'reset-password']),
      },
      evaluator: ALWAYS_ALLOW_EVALUATOR,
      auditLogger: memoryAudit,
    }),
  );

  return { app, auditLogger: memoryAudit };
}

// ---------------------------------------------------------------------------
// AdminAuditLogger implementations
// ---------------------------------------------------------------------------

describe('AdminAuditLogger implementations', () => {
  test('createMemoryAuditLogger returns an object with log, getEvents, clear', () => {
    const logger = createMemoryAuditLogger();
    expect(logger).toHaveProperty('log');
    expect(typeof logger.log).toBe('function');
    expect(logger).toHaveProperty('getEvents');
    expect(typeof logger.getEvents).toBe('function');
    expect(logger).toHaveProperty('clear');
    expect(typeof logger.clear).toBe('function');
  });

  test('createMemoryAuditLogger stores events in order', () => {
    const logger = createMemoryAuditLogger();
    const event1: AdminAuditEvent = {
      timestamp: new Date().toISOString(),
      route: '/test',
      method: 'GET',
      actor: 'admin',
      action: 'test.action',
      target: 't-1',
      result: 'success',
      tenantId: 'tenant-1',
    };
    const event2: AdminAuditEvent = {
      timestamp: new Date().toISOString(),
      route: '/test2',
      method: 'POST',
      actor: 'admin',
      action: 'test.action2',
      target: 't-2',
      result: 'failure',
      error: 'Something went wrong',
    };

    logger.log(event1);
    logger.log(event2);

    const events = logger.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(event1);
    expect(events[1]).toEqual(event2);
  });

  test('createMemoryAuditLogger.clear empties events', () => {
    const logger = createMemoryAuditLogger();
    logger.log({
      timestamp: new Date().toISOString(),
      route: '/test',
      method: 'GET',
      actor: 'admin',
      action: 'test.action',
      target: 't-1',
      result: 'success',
    });
    expect(logger.getEvents()).toHaveLength(1);
    logger.clear();
    expect(logger.getEvents()).toHaveLength(0);
  });

  test('createConsoleAuditLogger returns an object with log method', () => {
    const logger = createConsoleAuditLogger(
      NULL_LOGGER as Parameters<typeof createConsoleAuditLogger>[0],
    );
    expect(logger).toHaveProperty('log');
    expect(typeof logger.log).toBe('function');
  });

  test('createConsoleAuditLogger.log calls logger.info', () => {
    const infoSpy = mock(() => {});
    const logger = createConsoleAuditLogger({
      info: infoSpy,
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
      trace: mock(() => {}),
    } as Parameters<typeof createConsoleAuditLogger>[0]);

    const event: AdminAuditEvent = {
      timestamp: new Date().toISOString(),
      route: '/test',
      method: 'GET',
      actor: 'admin',
      action: 'test.action',
      target: 't-1',
      result: 'success',
    };
    logger.log(event);
    expect(infoSpy).toHaveBeenCalledWith('admin-audit-event', event);
  });
});

// ---------------------------------------------------------------------------
// Admin routes — audit events
// ---------------------------------------------------------------------------

describe('Admin routes — admin audit logging', () => {
  test('GET /users records a user.list audit event', async () => {
    const { app, managedUserProvider, auditLogger } = buildAdminApp();
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users');
    expect(res.status).toBe(200);

    const events = (auditLogger as ReturnType<typeof createMemoryAuditLogger>).getEvents();
    const listEvents = events.filter(e => e.action === 'user.list');
    expect(listEvents).toHaveLength(1);
    expect(listEvents[0]).toMatchObject({
      route: '/users',
      method: 'GET',
      actor: 'admin',
      action: 'user.list',
      result: 'success',
      tenantId: 'tenant-1',
    });
  });

  test('GET /users/:userId records a user.get audit event', async () => {
    const { app, managedUserProvider, auditLogger } = buildAdminApp();
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/u-1');
    expect(res.status).toBe(200);

    const events = (auditLogger as ReturnType<typeof createMemoryAuditLogger>).getEvents();
    const getEvents = events.filter(e => e.action === 'user.get');
    expect(getEvents).toHaveLength(1);
    expect(getEvents[0]).toMatchObject({
      route: '/users/:userId',
      method: 'GET',
      actor: 'admin',
      action: 'user.get',
      target: 'u-1',
      result: 'success',
      tenantId: 'tenant-1',
    });
  });

  test('DELETE /users/:userId records a user.delete audit event', async () => {
    const { app, managedUserProvider, auditLogger } = buildAdminApp();
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/u-1', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const events = (auditLogger as ReturnType<typeof createMemoryAuditLogger>).getEvents();
    const deleteEvents = events.filter(e => e.action === 'user.delete');
    expect(deleteEvents).toHaveLength(1);
    expect(deleteEvents[0]).toMatchObject({
      route: '/users/:userId',
      method: 'DELETE',
      actor: 'admin',
      action: 'user.delete',
      target: 'u-1',
      result: 'success',
      tenantId: 'tenant-1',
    });
  });

  test('POST /users/:userId/suspend records a user.suspend audit event', async () => {
    const { app, managedUserProvider, auditLogger } = buildAdminApp();
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/u-1/suspend', { method: 'POST' });
    expect(res.status).toBe(200);

    const events = (auditLogger as ReturnType<typeof createMemoryAuditLogger>).getEvents();
    const suspendEvents = events.filter(e => e.action === 'user.suspend');
    expect(suspendEvents).toHaveLength(1);
    expect(suspendEvents[0]).toMatchObject({
      route: '/users/:userId/suspend',
      method: 'POST',
      actor: 'admin',
      action: 'user.suspend',
      target: 'u-1',
      result: 'success',
      tenantId: 'tenant-1',
    });
  });

  test('admin routes work without auditLogger (null safety)', async () => {
    const { app, managedUserProvider } = buildAdminApp(undefined);
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users');
    expect(res.status).toBe(200);

    const getRes = await app.request('/users/u-1');
    expect(getRes.status).toBe(200);

    const delRes = await app.request('/users/u-1', { method: 'DELETE' });
    expect(delRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Permission routes — audit events
// ---------------------------------------------------------------------------

describe('Permission routes — admin audit logging', () => {
  test('POST /permissions/grants records a permission.evaluate audit event', async () => {
    const { app, auditLogger } = buildPermissionsApp();

    const res = await app.request('/permissions/grants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectId: 'u-1',
        subjectType: 'user',
        roles: ['editor'],
      }),
    });
    expect(res.status).toBe(201);

    const events = (auditLogger as ReturnType<typeof createMemoryAuditLogger>).getEvents();
    const grantEvents = events.filter(e => e.action === 'permission.evaluate');
    expect(grantEvents.length).toBeGreaterThanOrEqual(1);
    expect(grantEvents[0]).toMatchObject({
      route: '/grants',
      method: 'POST',
      actor: 'admin',
      result: 'success',
    });
  });

  test('DELETE /permissions/grants/:grantId records a permission.evaluate audit event', async () => {
    const { app, auditLogger } = buildPermissionsApp();

    const res = await app.request('/permissions/grants/grant-1', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const events = (auditLogger as ReturnType<typeof createMemoryAuditLogger>).getEvents();
    const grantEvents = events.filter(e => e.action === 'permission.evaluate');
    expect(grantEvents.length).toBeGreaterThanOrEqual(1);
    expect(grantEvents[0]).toMatchObject({
      route: '/grants/:grantId',
      method: 'DELETE',
      actor: 'admin',
      target: 'grant-1',
      result: 'success',
    });
  });

  test('GET /permissions/resources records a permission.registry.read audit event', async () => {
    const { app, auditLogger } = buildPermissionsApp();

    const res = await app.request('/permissions/resources');
    expect(res.status).toBe(200);

    const events = (auditLogger as ReturnType<typeof createMemoryAuditLogger>).getEvents();
    const readEvents = events.filter(e => e.action === 'permission.registry.read');
    expect(readEvents).toHaveLength(1);
    expect(readEvents[0]).toMatchObject({
      route: '/resources',
      method: 'GET',
      actor: 'admin',
      result: 'success',
    });
  });
});

// ---------------------------------------------------------------------------
// Mail routes — audit events
// ---------------------------------------------------------------------------

describe('Mail routes — admin audit logging', () => {
  test('POST /mail/templates/:name/preview records a mail.preview audit event', async () => {
    const { app, auditLogger } = buildMailApp();

    // The mail router registers paths as /mail/templates and
    // /mail/templates/:name/preview (they include the /mail/ prefix).
    // Mount at / so the full request path matches the route.
    const res = await app.request('/mail/templates/welcome/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    const events = (auditLogger as ReturnType<typeof createMemoryAuditLogger>).getEvents();
    const previewEvents = events.filter(e => e.action === 'mail.preview');
    expect(previewEvents).toHaveLength(1);
    expect(previewEvents[0]).toMatchObject({
      route: '/mail/templates/:name/preview',
      method: 'POST',
      actor: 'admin',
      target: 'welcome',
      result: 'success',
      tenantId: 'tenant-1',
    });
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('Admin audit logger — error handling', () => {
  test('throwing auditLogger does not crash the route handler', async () => {
    const throwingAuditLogger: AdminAuditLogger = {
      log: mock(() => {
        throw new Error('audit logger crash');
      }),
    };

    const { app, managedUserProvider } = buildAdminApp(throwingAuditLogger);
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users');
    expect(res.status).toBe(200);
  });

  test('rejecting auditLogger does not crash the route handler', async () => {
    const rejectingAuditLogger: AdminAuditLogger = {
      log: mock(() => Promise.reject(new Error('async audit crash'))),
    };

    const { app, managedUserProvider } = buildAdminApp(rejectingAuditLogger);
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users');
    expect(res.status).toBe(200);
  });
});
