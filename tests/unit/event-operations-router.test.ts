import { AUTH_RUNTIME_KEY } from '@auth/runtime';
import type { AuthRuntimeContext } from '@auth/runtime';
import { describe, expect, mock, test } from 'bun:test';
import { PERMISSIONS_STATE_KEY, attachContext, createRouter } from '@lastshotlabs/slingshot-core';
import type { AuditLogEntry, SlingshotContext } from '@lastshotlabs/slingshot-core';
import type { EventReliabilityOperations } from '@lastshotlabs/slingshot-events';
import { EVENT_RELIABILITY_OPERATIONS_KEY } from '../../src/framework/persistence/events/reliabilityOperations';
import { createEventOperationsRouter } from '../../src/framework/routes/eventOperations';

function makeApp(input: { allowed: boolean; validationCompatible?: boolean }) {
  const audits: AuditLogEntry[] = [];
  const retryEvent = mock(() => Promise.resolve(true));
  const operations: EventReliabilityOperations = {
    status: async () => ({
      counts: { pending: 0, leased: 0, delivered: 0, dead: 1 },
      oldestPendingAt: null,
      expiredLeases: 0,
    }),
    list: async () => [],
    inspect: async eventId => ({
      id: 'row-1',
      eventId,
      eventKey: 'orders:order.created',
      status: 'dead',
      attempts: 3,
      availableAt: '2026-01-01T00:00:00Z',
      leaseExpiresAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      deliveredAt: null,
      lastErrorCode: null,
      schemaVersion: 1,
      occurredAt: '2026-01-01T00:00:00Z',
      ownerPlugin: 'orders',
      requestTenantId: null,
      requestId: null,
      correlationId: null,
      source: null,
      scope: null,
      payloadPreview: { password: '[redacted]' },
      lastErrorMessage: null,
    }),
    validateReplay: async () =>
      input.validationCompatible === false
        ? {
            compatible: false,
            eventKey: 'orders:order.created',
            storedVersion: 1,
            currentVersion: 2,
            reason: 'missing-adapter',
          }
        : {
            compatible: true,
            eventKey: 'orders:order.created',
            storedVersion: 1,
            currentVersion: 1,
            adapted: false,
          },
    listReplayAudit: async () => [],
    retryEvent,
    retryAllDead: async () => 0,
    purgeDelivered: async () => 0,
    purgeInbox: async () => 0,
  };
  const permissionDefinition = {
    resourceType: 'event-operations',
    actions: ['events:read', 'events:operate'],
    roles: {},
  };
  const pluginState = new Map<string, unknown>([
    [
      AUTH_RUNTIME_KEY,
      {
        adapter: {
          getSuspended: async () => ({ suspended: false }),
          getEmailVerified: async () => true,
        },
        config: { primaryField: 'email' },
      } as unknown as AuthRuntimeContext,
    ],
    [
      PERMISSIONS_STATE_KEY,
      {
        evaluator: { can: async () => input.allowed },
        registry: {
          register: () => {},
          getDefinition: () => permissionDefinition,
          getActionsForRole: () => [],
          listResourceTypes: () => [permissionDefinition],
        },
        adapter: {},
      },
    ],
    [EVENT_RELIABILITY_OPERATIONS_KEY.name, operations],
  ]);
  const ctx = {
    pluginState,
    routeAuth: {
      userAuth: async (
        c: Parameters<NonNullable<SlingshotContext['routeAuth']>['userAuth']>[0],
        next: () => Promise<void>,
      ) => {
        c.set('actor', {
          id: 'operator-1',
          kind: 'user',
          tenantId: null,
          sessionId: 'session-1',
          roles: [],
          claims: {},
        });
        await next();
      },
      requireRole: () => async (_c: unknown, next: () => Promise<void>) => next(),
    },
    persistence: {
      auditLog: {
        async logEntry(entry: AuditLogEntry) {
          audits.push(entry);
        },
        async getLogs() {
          return { items: audits };
        },
      },
    },
  } as unknown as SlingshotContext;
  const app = createRouter();
  attachContext(app, ctx);
  app.route('/', createEventOperationsRouter({ enabled: true }));
  return { app, audits, retryEvent };
}

describe('event operations router', () => {
  test('denies missing permissions and audits the denial', async () => {
    const { app, audits } = makeApp({ allowed: false });
    const response = await app.request('/admin/events/outbox/status');
    expect(response.status).toBe(403);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'events:read',
      status: 403,
      meta: { allowed: false },
    });
  });

  test('rejects incompatible replay without mutation and audits it', async () => {
    const { app, audits, retryEvent } = makeApp({
      allowed: true,
      validationCompatible: false,
    });
    const response = await app.request('/admin/events/outbox/event-1/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'broker recovered' }),
    });
    expect(response.status).toBe(409);
    expect(retryEvent).not.toHaveBeenCalled();
    expect(audits.at(-1)).toMatchObject({
      action: 'events.retry',
      status: 409,
      resourceId: 'event-1',
    });
  });

  test('retries with the inspected optimistic version and audits success', async () => {
    const { app, audits, retryEvent } = makeApp({ allowed: true });
    const response = await app.request('/admin/events/outbox/event-1/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'broker recovered' }),
    });
    expect(response.status).toBe(200);
    expect(retryEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event-1', expectedVersion: 3 }),
    );
    expect(audits.at(-1)).toMatchObject({ action: 'events.retry', status: 200 });
  });
});
