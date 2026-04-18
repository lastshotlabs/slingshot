import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { StoreInfra } from '@lastshotlabs/slingshot-core';
import { createWebhooksTestApp } from '../../packages/slingshot-webhooks/src/testing';
import { getMongooseModule } from '../../src/lib/mongo';
import {
  connectTestMongo,
  disconnectTestServices,
  flushTestServices,
  getTestAppConn,
} from '../setup-docker';

const originalFetch = globalThis.fetch;

function adminHeaders(tenantId: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-user-id': 'admin-user',
    'x-role': 'admin',
    'x-tenant-id': tenantId,
  };
}

function createMongoInfra(): StoreInfra {
  return {
    appName: 'slingshot-webhooks-docker-mongo',
    getRedis() {
      throw new Error('redis not configured');
    },
    getMongo() {
      return { conn: getTestAppConn(), mg: getMongooseModule() };
    },
    getSqliteDb() {
      throw new Error('sqlite not configured');
    },
    getPostgres() {
      throw new Error('postgres not configured');
    },
  };
}

async function waitForDeliveries(
  app: Awaited<ReturnType<typeof createWebhooksTestApp>>['app'],
  endpointId: string,
  tenantId: string,
): Promise<Array<{ event: string; status: string; attempts: number }>> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const deliveriesResponse = await app.request(`/webhooks/endpoints/${endpointId}/deliveries`, {
      headers: adminHeaders(tenantId),
    });
    if (deliveriesResponse.status !== 200) {
      throw new Error(`Unexpected deliveries status: ${deliveriesResponse.status}`);
    }
    const deliveries = (await deliveriesResponse.json()) as {
      items: Array<{ event: string; status: string; attempts: number }>;
    };
    if (deliveries.items.length > 0) {
      return deliveries.items;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return [];
}

beforeAll(async () => {
  await connectTestMongo();
});

beforeEach(async () => {
  await connectTestMongo();
  await flushTestServices();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await disconnectTestServices();
});

describe('Webhooks MongoDB manifest runtime (docker)', () => {
  test('persists endpoints and deliveries through the manifest runtime and management routes', async () => {
    const tenantId = `tenant-mongo-${crypto.randomUUID()}`;
    const eventName = `auth:mongo:${crypto.randomUUID()}`;
    const { app, runtime, teardown } = await createWebhooksTestApp(
      { events: [eventName] },
      { storeType: 'mongo', storeInfra: createMongoInfra() },
    );

    try {
      const createResponse = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers: adminHeaders(tenantId),
        body: JSON.stringify({
          url: 'https://example.com/hooks/mongo',
          secret: 'super-secret-token',
          events: [eventName],
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as {
        id: string;
        enabled: boolean;
        secret: string;
      };
      expect(created.enabled).toBe(true);
      expect(created.secret).toBe('oken');

      const delivery = await runtime.createDelivery({
        endpointId: created.id,
        event: eventName,
        payload: JSON.stringify({ tenantId, kind: 'mongo-test' }),
        maxAttempts: 5,
      });
      await runtime.updateDelivery(delivery.id, {
        status: 'delivered',
        attempts: 1,
        nextRetryAt: null,
      });

      const deliveries = await waitForDeliveries(app, created.id, tenantId);
      const matchingDeliveries = deliveries.filter(delivery => delivery.event === eventName);
      expect(matchingDeliveries).toHaveLength(1);
      expect(matchingDeliveries[0]).toMatchObject({
        event: eventName,
        status: 'delivered',
        attempts: 1,
      });
    } finally {
      await teardown();
    }
  });

  test('findEndpointsForEvent respects event globs and disabled endpoints', async () => {
    const tenantId = `tenant-mongo-${crypto.randomUUID()}`;
    const event = `auth:user.created:${crypto.randomUUID()}`;
    const { app, runtime, teardown } = await createWebhooksTestApp(
      { events: [event] },
      { storeType: 'mongo', storeInfra: createMongoInfra() },
    );

    try {
      const matchingResponse = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers: adminHeaders(tenantId),
        body: JSON.stringify({
          url: 'https://example.com/hooks/matching',
          secret: 'matching-secret',
          events: [event],
        }),
      });
      const matching = (await matchingResponse.json()) as { id: string; url: string };

      const disabledResponse = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers: adminHeaders(tenantId),
        body: JSON.stringify({
          url: 'https://example.com/hooks/disabled',
          secret: 'disabled-secret',
          events: [event],
        }),
      });
      const disabled = (await disabledResponse.json()) as { id: string };

      const disableUpdateResponse = await app.request(`/webhooks/endpoints/${disabled.id}`, {
        method: 'PATCH',
        headers: adminHeaders(tenantId),
        body: JSON.stringify({ enabled: false }),
      });
      expect(disableUpdateResponse.status).toBe(200);

      const urls = (await runtime.findEndpointsForEvent(event)).map(entry => entry.url);
      expect(urls).toContain(matching.url);
      expect(urls).not.toContain('https://example.com/hooks/disabled');
    } finally {
      await teardown();
    }
  });
});
