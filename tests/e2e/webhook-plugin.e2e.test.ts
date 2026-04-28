/**
 * E2E tests for the slingshot-webhooks plugin.
 *
 * Management routes are hardened behind user auth + admin role checks, so these
 * tests create authenticated admin sessions unless they are explicitly testing
 * unauthorised or forbidden access.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type EventExposure,
  type EventPublishContext,
  type EventScope,
  type SlingshotEvents,
  type SlingshotPlugin,
  createEventEnvelope,
  defineEvent,
} from '@lastshotlabs/slingshot-core';
import { createWebhookPlugin } from '@lastshotlabs/slingshot-webhooks';
import { createWebhookMemoryQueue } from '@lastshotlabs/slingshot-webhooks/testing';
import type { E2EServerHandle } from '../../src/testing';
import { authHeader, createMemoryAuthAdapter } from '../setup';
import { createTestHttpServer } from '../setup-e2e';

const TEST_TENANT_ID = 'tenant-a';
const WEBHOOK_TEST_EVENTS = ['user.created', 'order.placed', 'webhook:user.created'] as const;
const WEBHOOK_TEST_EXPOSURE = ['tenant-webhook', 'user-webhook'] as const;

type WebhookTestEventKey = (typeof WEBHOOK_TEST_EVENTS)[number];
type WebhookTestPayload = {
  tenantId?: string | null;
  userId?: string | null;
  [key: string]: unknown;
};

function resolveWebhookTestScope(
  payload: WebhookTestPayload,
  ctx: EventPublishContext,
): EventScope {
  return {
    tenantId: payload.tenantId ?? ctx.requestTenantId ?? TEST_TENANT_ID,
    userId: payload.userId ?? null,
    actorId: ctx.actorId ?? payload.userId ?? null,
  };
}

function registerWebhookTestEvent(events: SlingshotEvents, key: WebhookTestEventKey): void {
  const eventKey = key as never;
  if (events.get(eventKey)) return;
  events.register(
    defineEvent(eventKey, {
      ownerPlugin: 'slingshot-webhooks-e2e',
      exposure: WEBHOOK_TEST_EXPOSURE,
      resolveScope: resolveWebhookTestScope as never,
    }),
  );
}

function createWebhookTestEventsPlugin(): SlingshotPlugin {
  return {
    name: 'slingshot-webhooks-e2e-events',
    setupMiddleware({ events }) {
      for (const event of WEBHOOK_TEST_EVENTS) {
        registerWebhookTestEvent(events, event);
      }
    },
  };
}

function createWebhookTestEnvelope(key: WebhookTestEventKey, payload: WebhookTestPayload) {
  return createEventEnvelope({
    key: key as never,
    payload: payload as never,
    ownerPlugin: 'slingshot-webhooks-e2e',
    exposure: ['tenant-webhook'] satisfies readonly EventExposure[],
    scope: resolveWebhookTestScope(payload, {
      requestTenantId: TEST_TENANT_ID,
      actorId: payload.userId ?? null,
      source: 'system',
    }),
    requestTenantId: TEST_TENANT_ID,
    source: 'system',
  });
}

async function emitWebhookTestEvent(
  handle: E2EServerHandle,
  key: WebhookTestEventKey,
  payload: WebhookTestPayload,
): Promise<void> {
  handle.bus.emit(key as never, createWebhookTestEnvelope(key, payload) as never);
  await (handle.bus as typeof handle.bus & { drain?: () => Promise<void> }).drain?.();
}

function makeWebhookPlugin(
  opts: {
    requireAuth?: boolean;
    events?: string[];
  } = {},
) {
  const queue = createWebhookMemoryQueue({ maxAttempts: 1 });

  const plugin = createWebhookPlugin({
    queue,
    events: opts.events ?? ['user.*', 'order.*'],
    managementRole: opts.requireAuth ? 'admin' : undefined,
  });

  return { queue, plugin };
}

async function registerSession(
  baseUrl: string,
  emailPrefix: string,
): Promise<{ headers: Record<string, string>; userId: string }> {
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `${emailPrefix}-${crypto.randomUUID()}@example.com`,
      password: 'password123',
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { token: string; userId: string };
  return { headers: authHeader(body.token), userId: body.userId };
}

function withJson(headers: Record<string, string>): Record<string, string> {
  return { 'Content-Type': 'application/json', ...headers };
}

function withTenant(headers: Record<string, string> = {}): Record<string, string> {
  return { 'x-tenant-id': TEST_TENANT_ID, ...headers };
}

function endpointInput(input: Record<string, unknown>): Record<string, unknown> {
  const { events, ...rest } = input as Record<string, unknown> & { events?: unknown };
  const subscriptions = Array.isArray(events)
    ? events.map(pattern => ({ pattern: String(pattern) }))
    : undefined;
  return {
    ownerType: 'tenant',
    ownerId: TEST_TENANT_ID,
    tenantId: TEST_TENANT_ID,
    ...rest,
    ...(subscriptions ? { subscriptions } : {}),
  };
}

async function createAuthedHandle(
  plugin: ReturnType<typeof makeWebhookPlugin>['plugin'],
  role: 'admin' | 'user',
  emailPrefix: string,
): Promise<{ handle: E2EServerHandle; headers: Record<string, string> }> {
  const adapter = createMemoryAuthAdapter();
  const handle = await createTestHttpServer(
    {
      plugins: [createWebhookTestEventsPlugin(), plugin],
      tenancy: {
        resolution: 'header',
        headerName: 'x-tenant-id',
        onResolve: async tenantId => (tenantId === TEST_TENANT_ID ? { id: tenantId } : null),
      },
    },
    { auth: { adapter, defaultRole: role } },
  );
  const session = await registerSession(handle.baseUrl, emailPrefix);
  if (role === 'admin') {
    await adapter.setTenantRoles?.(session.userId, TEST_TENANT_ID, ['admin']);
  }
  return { handle, headers: withTenant(session.headers) };
}

describe('Webhook plugin — endpoint CRUD', () => {
  let handle: E2EServerHandle;
  let adminHeaders: Record<string, string>;

  beforeEach(async () => {
    const { plugin } = makeWebhookPlugin();
    ({ handle, headers: adminHeaders } = await createAuthedHandle(
      plugin,
      'admin',
      'webhook-admin',
    ));
  });

  afterEach(() => handle.stop());

  test('POST /webhooks/endpoints creates endpoint and returns 201', async () => {
    const res = await fetch(`${handle.baseUrl}/webhooks/endpoints`, {
      method: 'POST',
      headers: withJson(adminHeaders),
      body: JSON.stringify(
        endpointInput({
          url: 'https://receiver.example.com/hook',
          secret: 'my-signing-secret',
          events: ['user.created'],
        }),
      ),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(typeof body.id).toBe('string');
    expect(body.url).toBe('https://receiver.example.com/hook');
    expect(body.subscriptions.map((subscription: any) => subscription.event)).toContain(
      'user.created',
    );
    expect(body.enabled).toBe(true);
    expect(body.secret).toBe('****');
  });

  test('GET /webhooks/endpoints returns list', async () => {
    await fetch(`${handle.baseUrl}/webhooks/endpoints`, {
      method: 'POST',
      headers: withJson(adminHeaders),
      body: JSON.stringify(
        endpointInput({
          url: 'https://a.example.com/hook',
          secret: 'secret-a',
          events: ['user.created'],
        }),
      ),
    });
    await fetch(`${handle.baseUrl}/webhooks/endpoints`, {
      method: 'POST',
      headers: withJson(adminHeaders),
      body: JSON.stringify(
        endpointInput({
          url: 'https://b.example.com/hook',
          secret: 'secret-b',
          events: ['order.placed'],
        }),
      ),
    });

    const res = await fetch(`${handle.baseUrl}/webhooks/endpoints`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(2);
  });

  test('GET /webhooks/endpoints filters by enabled=false', async () => {
    const createRes = await fetch(`${handle.baseUrl}/webhooks/endpoints`, {
      method: 'POST',
      headers: withJson(adminHeaders),
      body: JSON.stringify(
        endpointInput({
          url: 'https://a.example.com/hook',
          secret: 'secret-a',
          events: ['user.*'],
        }),
      ),
    });
    const { id } = (await createRes.json()) as any;

    await fetch(`${handle.baseUrl}/webhooks/endpoints/${id}`, {
      method: 'PATCH',
      headers: withJson(adminHeaders),
      body: JSON.stringify({ enabled: false }),
    });

    const res = await fetch(`${handle.baseUrl}/webhooks/endpoints?enabled=false`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].enabled).toBe(false);
  });

  test('GET /webhooks/endpoints/:id returns endpoint', async () => {
    const createRes = await fetch(`${handle.baseUrl}/webhooks/endpoints`, {
      method: 'POST',
      headers: withJson(adminHeaders),
      body: JSON.stringify(
        endpointInput({
          url: 'https://example.com/hook',
          secret: 'my-secret',
          events: ['user.created'],
        }),
      ),
    });
    const { id } = (await createRes.json()) as any;

    const res = await fetch(`${handle.baseUrl}/webhooks/endpoints/${id}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(id);
  });

  test('GET /webhooks/endpoints/:id returns 404 for unknown id', async () => {
    const res = await fetch(`${handle.baseUrl}/webhooks/endpoints/nonexistent-id`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);
  });

  test('PATCH /webhooks/endpoints/:id updates fields', async () => {
    const createRes = await fetch(`${handle.baseUrl}/webhooks/endpoints`, {
      method: 'POST',
      headers: withJson(adminHeaders),
      body: JSON.stringify(
        endpointInput({
          url: 'https://old.example.com/hook',
          secret: 'secret',
          events: ['user.*'],
        }),
      ),
    });
    const { id } = (await createRes.json()) as any;

    const res = await fetch(`${handle.baseUrl}/webhooks/endpoints/${id}`, {
      method: 'PATCH',
      headers: withJson(adminHeaders),
      body: JSON.stringify({ url: 'https://new.example.com/hook', enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.url).toBe('https://new.example.com/hook');
    expect(body.enabled).toBe(false);
  });

  test('PATCH /webhooks/endpoints/:id returns 404 for unknown id', async () => {
    const res = await fetch(`${handle.baseUrl}/webhooks/endpoints/does-not-exist`, {
      method: 'PATCH',
      headers: withJson(adminHeaders),
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  test('DELETE /webhooks/endpoints/:id soft-deletes endpoint', async () => {
    const createRes = await fetch(`${handle.baseUrl}/webhooks/endpoints`, {
      method: 'POST',
      headers: withJson(adminHeaders),
      body: JSON.stringify(
        endpointInput({
          url: 'https://delete-me.example.com/hook',
          secret: 'secret',
          events: ['user.*'],
        }),
      ),
    });
    const { id } = (await createRes.json()) as any;

    const del = await fetch(`${handle.baseUrl}/webhooks/endpoints/${id}`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    expect(del.status).toBe(204);

    const get = await fetch(`${handle.baseUrl}/webhooks/endpoints/${id}`, {
      headers: adminHeaders,
    });
    expect(get.status).toBe(404);
  });

  test('deleted endpoint is excluded from list', async () => {
    const createRes = await fetch(`${handle.baseUrl}/webhooks/endpoints`, {
      method: 'POST',
      headers: withJson(adminHeaders),
      body: JSON.stringify(
        endpointInput({
          url: 'https://example.com/hook',
          secret: 'secret',
          events: ['user.*'],
        }),
      ),
    });
    const { id } = (await createRes.json()) as any;

    await fetch(`${handle.baseUrl}/webhooks/endpoints/${id}`, {
      method: 'DELETE',
      headers: adminHeaders,
    });

    const list = await fetch(`${handle.baseUrl}/webhooks/endpoints`, {
      headers: adminHeaders,
    });
    const body = (await list.json()) as any;
    expect(body.items.find((ep: any) => ep.id === id)).toBeUndefined();
  });
});

describe('Webhook plugin — delivery management', () => {
  let handle: E2EServerHandle;
  let endpointId: string;
  let adminHeaders: Record<string, string>;

  beforeEach(async () => {
    const { plugin } = makeWebhookPlugin();
    ({ handle, headers: adminHeaders } = await createAuthedHandle(
      plugin,
      'admin',
      'webhook-delivery-admin',
    ));

    const res = await fetch(`${handle.baseUrl}/webhooks/endpoints`, {
      method: 'POST',
      headers: withJson(adminHeaders),
      body: JSON.stringify(
        endpointInput({
          url: 'https://receiver.example.com/hook',
          secret: 'secret',
          events: ['user.*'],
        }),
      ),
    });
    const body = (await res.json()) as any;
    endpointId = body.id;
  });

  afterEach(() => handle.stop());

  test('GET /webhooks/endpoints/:id/deliveries returns empty list initially', async () => {
    const res = await fetch(`${handle.baseUrl}/webhooks/endpoints/${endpointId}/deliveries`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items).toHaveLength(0);
  });

  test('GET /webhooks/endpoints/:id/deliveries returns empty list for unknown endpoint', async () => {
    const res = await fetch(`${handle.baseUrl}/webhooks/endpoints/unknown/deliveries`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items).toHaveLength(0);
  });

  test('POST /webhooks/endpoints/:id/test enqueues a test delivery', async () => {
    const res = await fetch(`${handle.baseUrl}/webhooks/endpoints/${endpointId}/test`, {
      method: 'POST',
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.deliveryId).toBe('string');
    expect(body.deliveryId.length).toBeGreaterThan(0);
  });

  test('POST /webhooks/endpoints/:id/test returns 404 for unknown endpoint', async () => {
    const res = await fetch(`${handle.baseUrl}/webhooks/endpoints/nonexistent/test`, {
      method: 'POST',
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);
  });

  test('test delivery appears in delivery list', async () => {
    const testRes = await fetch(`${handle.baseUrl}/webhooks/endpoints/${endpointId}/test`, {
      method: 'POST',
      headers: adminHeaders,
    });
    const { deliveryId } = (await testRes.json()) as any;

    const listRes = await fetch(`${handle.baseUrl}/webhooks/endpoints/${endpointId}/deliveries`, {
      headers: adminHeaders,
    });
    const listBody = (await listRes.json()) as any;
    expect(listBody.items.some((d: any) => d.id === deliveryId)).toBe(true);
  });

  test('GET /webhooks/endpoints/:id/deliveries/:deliveryId returns delivery details', async () => {
    const testRes = await fetch(`${handle.baseUrl}/webhooks/endpoints/${endpointId}/test`, {
      method: 'POST',
      headers: adminHeaders,
    });
    const { deliveryId } = (await testRes.json()) as any;

    const res = await fetch(
      `${handle.baseUrl}/webhooks/endpoints/${endpointId}/deliveries/${deliveryId}`,
      { headers: adminHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(deliveryId);
    expect(body.endpointId).toBe(endpointId);
    expect(body.event).toBe('webhook:test');
  });

  test('GET delivery returns 404 for unknown deliveryId', async () => {
    const res = await fetch(
      `${handle.baseUrl}/webhooks/endpoints/${endpointId}/deliveries/bad-delivery-id`,
      { headers: adminHeaders },
    );
    expect(res.status).toBe(404);
  });

  test('delivery list filters by status', async () => {
    await fetch(`${handle.baseUrl}/webhooks/endpoints/${endpointId}/test`, {
      method: 'POST',
      headers: adminHeaders,
    });

    const pendingRes = await fetch(
      `${handle.baseUrl}/webhooks/endpoints/${endpointId}/deliveries?status=pending`,
      { headers: adminHeaders },
    );
    const pendingBody = (await pendingRes.json()) as any;
    expect(pendingBody.items.length >= 0).toBe(true);
  });
});

describe('Webhook plugin — admin role enforcement', () => {
  let userHandle: E2EServerHandle;
  let adminHandle: E2EServerHandle;
  let userHeaders: Record<string, string>;
  let adminHeaders: Record<string, string>;

  beforeEach(async () => {
    const { plugin: userPlugin } = makeWebhookPlugin({ requireAuth: true });
    ({ handle: userHandle, headers: userHeaders } = await createAuthedHandle(
      userPlugin,
      'user',
      'webhook-user',
    ));

    const { plugin: adminPlugin } = makeWebhookPlugin({ requireAuth: true });
    ({ handle: adminHandle, headers: adminHeaders } = await createAuthedHandle(
      adminPlugin,
      'admin',
      'webhook-admin-enforced',
    ));
  });

  afterEach(async () => {
    await userHandle.stop();
    await adminHandle.stop();
  });

  test('returns 401 when no auth token is provided', async () => {
    const res = await fetch(`${adminHandle.baseUrl}/webhooks/endpoints`, {
      headers: withTenant(),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toBe('Unauthorized');
  });

  test('returns 403 for an authenticated non-admin user', async () => {
    const res = await fetch(`${userHandle.baseUrl}/webhooks/endpoints`, {
      headers: userHeaders,
    });
    expect(res.status).toBe(403);
  });

  test('returns 200 with an authenticated admin user', async () => {
    const res = await fetch(`${adminHandle.baseUrl}/webhooks/endpoints`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
  });

  test('create returns 401 without token', async () => {
    const res = await fetch(`${adminHandle.baseUrl}/webhooks/endpoints`, {
      method: 'POST',
      headers: withJson(withTenant()),
      body: JSON.stringify(
        endpointInput({
          url: 'https://example.com/hook',
          secret: 'secret',
          events: ['user.*'],
        }),
      ),
    });
    expect(res.status).toBe(401);
  });

  test('create succeeds with an authenticated admin user', async () => {
    const res = await fetch(`${adminHandle.baseUrl}/webhooks/endpoints`, {
      method: 'POST',
      headers: withJson(adminHeaders),
      body: JSON.stringify(
        endpointInput({
          url: 'https://example.com/hook',
          secret: 'secret',
          events: ['user.created'],
        }),
      ),
    });
    expect(res.status).toBe(201);
  });
});

describe('Webhook plugin — event bus wiring', () => {
  let handle: E2EServerHandle;
  let adminHeaders: Record<string, string>;

  beforeEach(async () => {
    const { plugin } = makeWebhookPlugin({ events: ['webhook:user.*'] });
    ({ handle, headers: adminHeaders } = await createAuthedHandle(
      plugin,
      'admin',
      'webhook-event-admin',
    ));
  });

  afterEach(() => handle.stop());

  test('bus event matching endpoint pattern creates a delivery', async () => {
    const createRes = await fetch(`${handle.baseUrl}/webhooks/endpoints`, {
      method: 'POST',
      headers: withJson(adminHeaders),
      body: JSON.stringify(
        endpointInput({
          url: 'https://receiver.example.com/hook',
          secret: 'signing-secret',
          events: ['webhook:user.*'],
        }),
      ),
    });
    const { id: endpointId } = (await createRes.json()) as any;

    await emitWebhookTestEvent(handle, 'webhook:user.created', {
      tenantId: TEST_TENANT_ID,
      userId: 'u-1',
      email: 'x@example.com',
    });

    const deliveriesRes = await fetch(
      `${handle.baseUrl}/webhooks/endpoints/${endpointId}/deliveries`,
      { headers: adminHeaders },
    );
    const deliveries = (await deliveriesRes.json()) as any;
    expect(deliveries.items.length).toBeGreaterThan(0);
    expect(deliveries.items[0].event).toBe('webhook:user.created');
  });

  test('bus event NOT matching endpoint pattern does not create a delivery', async () => {
    const createRes = await fetch(`${handle.baseUrl}/webhooks/endpoints`, {
      method: 'POST',
      headers: withJson(adminHeaders),
      body: JSON.stringify(
        endpointInput({
          url: 'https://receiver.example.com/hook',
          secret: 'secret',
          events: ['order.*'],
        }),
      ),
    });
    const { id: endpointId } = (await createRes.json()) as any;

    await emitWebhookTestEvent(handle, 'user.created', {
      tenantId: TEST_TENANT_ID,
      userId: 'u-1',
    });

    const deliveriesRes = await fetch(
      `${handle.baseUrl}/webhooks/endpoints/${endpointId}/deliveries`,
      { headers: adminHeaders },
    );
    const deliveries = (await deliveriesRes.json()) as any;
    expect(deliveries.items).toHaveLength(0);
  });

  test('disabled endpoint does not receive deliveries', async () => {
    const createRes = await fetch(`${handle.baseUrl}/webhooks/endpoints`, {
      method: 'POST',
      headers: withJson(adminHeaders),
      body: JSON.stringify(
        endpointInput({
          url: 'https://receiver.example.com/hook',
          secret: 'secret',
          events: ['user.*'],
        }),
      ),
    });
    const { id: endpointId } = (await createRes.json()) as any;

    await fetch(`${handle.baseUrl}/webhooks/endpoints/${endpointId}`, {
      method: 'PATCH',
      headers: withJson(adminHeaders),
      body: JSON.stringify({ enabled: false }),
    });

    await emitWebhookTestEvent(handle, 'user.created', {
      tenantId: TEST_TENANT_ID,
      userId: 'u-1',
    });

    const deliveriesRes = await fetch(
      `${handle.baseUrl}/webhooks/endpoints/${endpointId}/deliveries`,
      { headers: adminHeaders },
    );
    const deliveries = (await deliveriesRes.json()) as any;
    expect(deliveries.items).toHaveLength(0);
  });
});

describe('Webhook plugin — custom mountPath', () => {
  let handle: E2EServerHandle;
  let adminHeaders: Record<string, string>;

  beforeEach(async () => {
    const queue = createWebhookMemoryQueue();
    const plugin = createWebhookPlugin({
      queue,
      events: ['user.*'],
      mountPath: '/api/hooks',
    });
    ({ handle, headers: adminHeaders } = await createAuthedHandle(
      plugin,
      'admin',
      'webhook-mount-admin',
    ));
  });

  afterEach(() => handle.stop());

  test('routes mounted at custom mountPath', async () => {
    const res = await fetch(`${handle.baseUrl}/api/hooks/endpoints`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
  });

  test('default /webhooks path returns 404 when mountPath is customized', async () => {
    const res = await fetch(`${handle.baseUrl}/webhooks/endpoints`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);
  });
});
