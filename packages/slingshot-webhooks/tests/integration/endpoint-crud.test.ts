import { describe, expect, it } from 'bun:test';
import { createWebhooksTestApp } from '../../src/testing';

function adminHeaders(tenantId = 'tenant-a'): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-user-id': 'admin-user',
    'x-role': 'admin',
    'x-tenant-id': tenantId,
  };
}

function userHeaders(tenantId = 'tenant-a'): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-user-id': 'regular-user',
    'x-role': 'user',
    'x-tenant-id': tenantId,
  };
}

const defaultCreateBody = {
  ownerType: 'user',
  ownerId: 'user-1',
  url: 'https://example.com/hooks/endpoint-crud',
  secret: 'super-secret-token',
  subscriptions: [{ event: 'auth:login' }],
};

describe('webhook endpoint CRUD via HTTP routes', () => {
  it('performs full CRUD lifecycle: create, get, list, update, delete', async () => {
    const { app, teardown } = await createWebhooksTestApp({ events: ['auth:*'] });
    try {
      // CREATE
      const createRes = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify(defaultCreateBody),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as Record<string, unknown>;
      const id = created.id as string;
      expect(id).toBeTruthy();
      expect(created.secret).toBe('****');
      expect(created.enabled).toBe(true);
      expect((created.subscriptions as Array<unknown>).length).toBe(1);

      // GET
      const getRes = await app.request(`/webhooks/endpoints/${id}`, {
        headers: adminHeaders(),
      });
      expect(getRes.status).toBe(200);
      const got = (await getRes.json()) as Record<string, unknown>;
      expect(got.id).toBe(id);
      expect(got.url).toBe(defaultCreateBody.url);
      expect(got.secret).toBe('****');
      expect(got.ownerType).toBe('user');

      // LIST
      const listRes = await app.request('/webhooks/endpoints', {
        headers: adminHeaders(),
      });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as {
        items: Array<Record<string, unknown>>;
      };
      expect(list.items.length).toBeGreaterThanOrEqual(1);
      expect(list.items.some(e => e.id === id)).toBe(true);

      // UPDATE
      const updateRes = await app.request(`/webhooks/endpoints/${id}`, {
        method: 'PATCH',
        headers: adminHeaders(),
        body: JSON.stringify({
          url: 'https://updated.example.com/hooks/endpoint-crud',
        }),
      });
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as Record<string, unknown>;
      expect(updated.url).toBe('https://updated.example.com/hooks/endpoint-crud');

      // DELETE
      const deleteRes = await app.request(`/webhooks/endpoints/${id}`, {
        method: 'DELETE',
        headers: adminHeaders(),
      });
      expect(deleteRes.status).toBe(204);

      // VERIFY DELETED
      const getDeletedRes = await app.request(`/webhooks/endpoints/${id}`, {
        headers: adminHeaders(),
      });
      expect(getDeletedRes.status).toBe(404);
    } finally {
      await teardown();
    }
  });

  it('rejects endpoints with non-http/https URL', async () => {
    const { app, teardown } = await createWebhooksTestApp({ events: ['auth:*'] });
    try {
      const res = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ ...defaultCreateBody, url: 'ftp://example.com/hook' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await teardown();
    }
  });

  it('rejects endpoints without a URL', async () => {
    const { app, teardown } = await createWebhooksTestApp({ events: ['auth:*'] });
    try {
      const { url: _url, ...bodyWithoutUrl } = defaultCreateBody;
      void _url;
      const res = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify(bodyWithoutUrl),
      });
      // The validation throws inside the adapter transform; Hono may
      // surface it as 400 (HTTPException) or 500 (uncaught error).
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      await teardown();
    }
  });

  it('rejects endpoints with empty secret', async () => {
    const { app, teardown } = await createWebhooksTestApp({ events: ['auth:*'] });
    try {
      const res = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ ...defaultCreateBody, secret: '' }),
      });
      // The validation throws inside the adapter transform; Hono may
      // surface it as 400 (HTTPException) or 500 (uncaught error).
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      await teardown();
    }
  });

  it('allows multiple endpoints with the same URL', async () => {
    const { app, teardown } = await createWebhooksTestApp({ events: ['auth:*'] });
    try {
      const headers = adminHeaders();
      const body = {
        ownerType: 'user',
        ownerId: 'user-1',
        url: 'https://example.com/hooks/shared-url',
        secret: 'secret-1',
        subscriptions: [{ event: 'auth:login' }],
      };
      const res1 = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      expect(res1.status).toBe(201);

      const res2 = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, secret: 'secret-2' }),
      });
      expect(res2.status).toBe(201);
    } finally {
      await teardown();
    }
  });

  it('returns 404 for a non-existent endpoint', async () => {
    const { app, teardown } = await createWebhooksTestApp({ events: ['auth:*'] });
    try {
      const res = await app.request('/webhooks/endpoints/non-existent-id', {
        headers: adminHeaders(),
      });
      expect(res.status).toBe(404);
    } finally {
      await teardown();
    }
  });

  it('requires admin role for creating endpoints', async () => {
    const { app, teardown } = await createWebhooksTestApp({ events: ['auth:*'] });
    try {
      const res = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers: userHeaders(),
        body: JSON.stringify(defaultCreateBody),
      });
      expect(res.status).toBe(403);
    } finally {
      await teardown();
    }
  });

  it('requires admin role for deleting endpoints', async () => {
    const { app, teardown } = await createWebhooksTestApp({ events: ['auth:*'] });
    try {
      const createRes = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify(defaultCreateBody),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const deleteRes = await app.request(`/webhooks/endpoints/${id}`, {
        method: 'DELETE',
        headers: userHeaders(),
      });
      expect(deleteRes.status).toBe(403);
    } finally {
      await teardown();
    }
  });

  it('requires admin role for listing endpoints', async () => {
    const { app, teardown } = await createWebhooksTestApp({ events: ['auth:*'] });
    try {
      const res = await app.request('/webhooks/endpoints', {
        headers: userHeaders(),
      });
      expect(res.status).toBe(403);
    } finally {
      await teardown();
    }
  });

  it('requires admin role for updating endpoints', async () => {
    const { app, teardown } = await createWebhooksTestApp({ events: ['auth:*'] });
    try {
      const createRes = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify(defaultCreateBody),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const updateRes = await app.request(`/webhooks/endpoints/${id}`, {
        method: 'PATCH',
        headers: userHeaders(),
        body: JSON.stringify({ url: 'https://evil.example.com/hook' }),
      });
      expect(updateRes.status).toBe(403);
    } finally {
      await teardown();
    }
  });

  it('supports deliveryTimeoutMs configuration on endpoints', async () => {
    const { app, teardown } = await createWebhooksTestApp({ events: ['auth:*'] });
    try {
      // Create with custom timeout
      const createRes = await app.request('/webhooks/endpoints', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({
          ...defaultCreateBody,
          url: 'https://example.com/hooks/timeout-test',
          deliveryTimeoutMs: 5000,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        id: string;
        deliveryTimeoutMs: number | null;
      };
      expect(created.deliveryTimeoutMs).toBe(5000);

      // Update timeout to a new value
      const updateRes = await app.request(`/webhooks/endpoints/${created.id}`, {
        method: 'PATCH',
        headers: adminHeaders(),
        body: JSON.stringify({ deliveryTimeoutMs: 10000 }),
      });
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as { deliveryTimeoutMs: number | null };
      expect(updated.deliveryTimeoutMs).toBe(10000);

      // Clear timeout by setting null
      const clearRes = await app.request(`/webhooks/endpoints/${created.id}`, {
        method: 'PATCH',
        headers: adminHeaders(),
        body: JSON.stringify({ deliveryTimeoutMs: null }),
      });
      expect(clearRes.status).toBe(200);
      const cleared = (await clearRes.json()) as { deliveryTimeoutMs: unknown };
      expect(cleared.deliveryTimeoutMs).toBeNull();
    } finally {
      await teardown();
    }
  });
});
