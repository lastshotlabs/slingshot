import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createThreadStateGuardMiddleware } from '../../../src/middleware/threadStateGuard';

function stubThreadAdapter(thread) {
  return {
    getById: async () => thread ?? null,
  };
}
function buildApp(threadAdapter) {
  const app = new Hono();
  app.use('/threads/:threadId/*', createThreadStateGuardMiddleware({ threadAdapter }));
  app.use('/replies', createThreadStateGuardMiddleware({ threadAdapter }));
  app.post('/threads/:threadId/replies', c => c.json({ ok: true }));
  app.post('/replies', c => c.json({ ok: true }));
  return app;
}
describe('threadStateGuard middleware', () => {
  test('published and unlocked thread allows reply', async () => {
    const app = buildApp(stubThreadAdapter({ id: 't1', status: 'published', locked: false }));
    const res = await app.request('/threads/t1/replies', { method: 'POST' });
    expect(res.status).toBe(200);
  });
  test('locked thread returns 403', async () => {
    const app = buildApp(stubThreadAdapter({ id: 't1', status: 'published', locked: true }));
    const res = await app.request('/threads/t1/replies', { method: 'POST' });
    expect(res.status).toBe(403);
  });
  test('unpublished thread returns 404', async () => {
    const app = buildApp(stubThreadAdapter({ id: 't1', status: 'draft', locked: false }));
    const res = await app.request('/threads/t1/replies', { method: 'POST' });
    expect(res.status).toBe(404);
  });
  test('missing thread returns 404', async () => {
    const app = buildApp(stubThreadAdapter(null));
    const res = await app.request('/threads/t1/replies', { method: 'POST' });
    expect(res.status).toBe(404);
  });
  test('body-scoped reply creation checks threadId from JSON body', async () => {
    const app = buildApp(stubThreadAdapter({ id: 't1', status: 'published', locked: false }));
    const res = await app.request('/replies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 't1' }),
    });
    expect(res.status).toBe(200);
  });
  test('body-scoped reply creation blocks locked thread', async () => {
    const app = buildApp(stubThreadAdapter({ id: 't1', status: 'published', locked: true }));
    const res = await app.request('/replies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 't1' }),
    });
    expect(res.status).toBe(403);
  });
});
