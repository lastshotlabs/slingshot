import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import type { StoreInfra } from '@lastshotlabs/slingshot-core';
import { createWebhooksTestApp } from '../../packages/slingshot-webhooks/src/testing';

const CONNECTION =
  process.env.TEST_POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5433/slingshot_test';
const originalFetch = globalThis.fetch;

function adminHeaders(tenantId: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-user-id': 'admin-user',
    'x-role': 'admin',
    'x-tenant-id': tenantId,
  };
}

function createPostgresInfra(pool: Pool): StoreInfra {
  return {
    appName: 'slingshot-webhooks-docker-postgres',
    getRedis() {
      throw new Error('redis not configured');
    },
    getMongo() {
      throw new Error('mongo not configured');
    },
    getSqliteDb() {
      throw new Error('sqlite not configured');
    },
    getPostgres() {
      return { pool, db: null };
    },
  };
}

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: CONNECTION });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await pool.end();
});

describe('Webhooks Postgres manifest runtime (docker)', () => {
  test('persists endpoints and deliveries through the manifest runtime and management routes', async () => {
    const tenantId = `tenant-postgres-${crypto.randomUUID()}`;
    const eventName = `auth:postgres:${crypto.randomUUID()}`;
    const { app, runtime, teardown } = await createWebhooksTestApp(
      { events: [eventName] },
      { storeType: 'postgres', storeInfra: createPostgresInfra(pool) },
    );

    try {
      const createResponse = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers: adminHeaders(tenantId),
        body: JSON.stringify({
          url: 'https://example.com/hooks/postgres',
          secret: 'super-secret-token',
          events: [eventName],
          bindingKeys: ['tenant'],
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
        payload: JSON.stringify({ tenantId, kind: 'postgres-test' }),
        maxAttempts: 5,
      });
      await runtime.updateDelivery(delivery.id, {
        status: 'delivered',
        attempts: 1,
        nextRetryAt: null,
      });

      const deliveriesResponse = await app.request(`/webhooks/endpoints/${created.id}/deliveries`, {
        headers: adminHeaders(tenantId),
      });
      expect(deliveriesResponse.status).toBe(200);
      const deliveries = (await deliveriesResponse.json()) as {
        items: Array<{ event: string; status: string; attempts: number }>;
      };
      const matchingDeliveries = deliveries.items.filter(delivery => delivery.event === eventName);
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
    const tenantId = `tenant-postgres-${crypto.randomUUID()}`;
    const event = `auth:user.created:${crypto.randomUUID()}`;
    const { app, runtime, teardown } = await createWebhooksTestApp(
      { events: [event] },
      { storeType: 'postgres', storeInfra: createPostgresInfra(pool) },
    );

    try {
      const matchingResponse = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers: adminHeaders(tenantId),
        body: JSON.stringify({
          url: 'https://example.com/hooks/matching',
          secret: 'matching-secret',
          events: [event],
          bindingKeys: ['tenant'],
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
          bindingKeys: ['tenant'],
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
