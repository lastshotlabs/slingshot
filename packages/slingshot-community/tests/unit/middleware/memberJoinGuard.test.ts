import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createMemberJoinGuardMiddleware } from '../../../src/middleware/memberJoinGuard';
import { setVar } from './_helpers';

function buildApp(userId?: string) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (userId) setVar(c, 'authUserId', userId);
    await next();
  });
  app.use('*', createMemberJoinGuardMiddleware());
  app.post('/members', async c => {
    const body = await c.req.json();
    return c.json(body);
  });
  return app;
}

async function post(app: Hono, body: unknown) {
  return app.request('/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('memberJoinGuard middleware', () => {
  test('returns 401 when not authenticated', async () => {
    const app = buildApp();
    const res = await post(app, { containerId: 'c1' });
    expect(res.status).toBe(401);
  });

  test('normalizes userId to the authenticated user', async () => {
    const app = buildApp('user-1');
    const res = await post(app, { containerId: 'c1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; role: string };
    expect(body.userId).toBe('user-1');
    expect(body.role).toBe('member');
  });

  test('rejects when body tries to join a different user', async () => {
    const app = buildApp('user-1');
    const res = await post(app, { containerId: 'c1', userId: 'user-2' });
    expect(res.status).toBe(403);
  });

  test('rejects when body tries to self-promote to owner', async () => {
    const app = buildApp('user-1');
    const res = await post(app, { containerId: 'c1', role: 'owner' });
    expect(res.status).toBe(403);
  });

  test('rejects when body tries to self-promote to moderator', async () => {
    const app = buildApp('user-1');
    const res = await post(app, { containerId: 'c1', role: 'moderator' });
    expect(res.status).toBe(403);
  });

  test('allows explicit role=member in body', async () => {
    const app = buildApp('user-1');
    const res = await post(app, { containerId: 'c1', userId: 'user-1', role: 'member' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; role: string };
    expect(body.userId).toBe('user-1');
    expect(body.role).toBe('member');
  });

  test('rejects tenant spoofing when tenantId context is set', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      setVar(c, 'authUserId', 'user-1');
      setVar(c, 'tenantId', 'tenant-a');
      await next();
    });
    app.use('*', createMemberJoinGuardMiddleware());
    app.post('/members', async c => c.json(await c.req.json()));

    const res = await post(app, { containerId: 'c1', tenantId: 'tenant-b' });
    expect(res.status).toBe(403);
  });

  test('returns 400 on invalid JSON body', async () => {
    const app = buildApp('user-1');
    const res = await app.request('/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 on non-object body', async () => {
    const app = buildApp('user-1');
    const res = await app.request('/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(res.status).toBe(400);
  });
});
