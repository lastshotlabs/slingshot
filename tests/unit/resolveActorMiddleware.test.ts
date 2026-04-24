import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { createActorResolutionMiddleware } from '../../src/framework/middleware/resolveActor';

describe('createActorResolutionMiddleware', () => {
  test('publishes actor onto request context from auth variables', async () => {
    const app = new Hono<AppEnv>();

    app.use('*', async (c, next) => {
      c.set(
        'actor',
        Object.freeze({
          id: 'user-1',
          kind: 'user' as const,
          tenantId: 'tenant-1',
          sessionId: 'sess-1',
          roles: null,
          claims: {},
        }),
      );
      await next();
    });
    app.use('*', createActorResolutionMiddleware());
    app.get('/actor', c => c.json(c.get('actor'), 200));

    const res = await app.request('/actor');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: 'user-1',
      kind: 'user',
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
    });
  });
});
