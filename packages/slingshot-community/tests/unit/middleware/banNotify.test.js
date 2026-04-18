import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createBanNotifyMiddleware } from '../../../src/middleware/banNotify';
import { setVar } from './_helpers';

function stubBuilder() {
  const notifications = [];
  const builder = {
    async notify(payload) {
      notifications.push(payload);
    },
  };
  return { builder, notifications };
}
function buildApp(builder) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    setVar(c, 'tenantId', 'tenant-1');
    await next();
  });
  app.use('*', createBanNotifyMiddleware({ builder }));
  app.post('/bans', c =>
    c.json({
      id: 'ban-1',
      userId: 'user-42',
      bannedBy: 'mod-1',
      containerId: 'c1',
      reason: 'Spam',
      expiresAt: null,
    }),
  );
  app.post('/bans-fail', c => c.json({ error: 'nope' }, 400));
  return app;
}
describe('banNotify middleware', () => {
  test('creates notification on successful ban creation', async () => {
    const { builder, notifications } = stubBuilder();
    const app = buildApp(builder);
    const res = await app.request('/bans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.userId).toBe('user-42');
    expect(notifications[0]?.type).toBe('community:ban');
    expect(notifications[0]?.actorId).toBe('mod-1');
    expect(notifications[0]?.scopeId).toBe('c1');
  });
  test('skips notification on non-2xx response', async () => {
    const { builder, notifications } = stubBuilder();
    const app = buildApp(builder);
    const res = await app.request('/bans-fail', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(notifications).toHaveLength(0);
  });
  test('skips notification when response body lacks userId', async () => {
    const { builder, notifications } = stubBuilder();
    const app = new Hono();
    app.use('*', createBanNotifyMiddleware({ builder }));
    app.post('/bans', c => c.json({ id: 'ban-1' }));
    const res = await app.request('/bans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(notifications).toHaveLength(0);
  });
  test('response body is still readable after middleware clones it', async () => {
    const { builder } = stubBuilder();
    const app = buildApp(builder);
    const res = await app.request('/bans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await res.json();
    expect(body.id).toBe('ban-1');
  });
});
