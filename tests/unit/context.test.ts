import { createRoute } from '@hono/zod-openapi';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createRouter } from '@lastshotlabs/slingshot-core';

describe('createRouter', () => {
  test('returns an OpenAPIHono instance', () => {
    const router = createRouter();
    expect(router).toBeDefined();
    expect(typeof router.openapi).toBe('function');
    expect(typeof router.fetch).toBe('function');
  });

  test('defaultHook returns 400 on validation failure', async () => {
    const router = createRouter();
    const route = createRoute({
      method: 'post',
      path: '/test',
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({ name: z.string().min(3) }),
            },
          },
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
          description: 'OK',
        },
      },
    });

    router.openapi(route, c => c.json({ ok: true }));

    const res = await router.request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ab' }), // too short
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
    expect(body.details[0]).toHaveProperty('path');
    expect(body.details[0]).toHaveProperty('message');
    // requestId defaults to "unknown" when not set via middleware
    expect(body).toHaveProperty('requestId');
  });
});
