import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { EntityAdapter } from '@lastshotlabs/slingshot-core';
import { createThreadStateGuardMiddleware } from '../../../src/middleware/threadStateGuard';
import type { Thread } from '../../../src/types/models';

type ThreadAdapter = EntityAdapter<Thread, Record<string, unknown>, Record<string, unknown>>;

function stubThreadAdapter(thread: Partial<Thread> | null): ThreadAdapter {
  return {
    getById: async () => (thread as Thread) ?? null,
  } as unknown as ThreadAdapter;
}

function buildApp(threadAdapter: ThreadAdapter) {
  const app = new Hono();
  app.use('/threads/:threadId/*', createThreadStateGuardMiddleware({ threadAdapter }));
  app.use('/replies', createThreadStateGuardMiddleware({ threadAdapter }));
  app.post('/threads/:threadId/replies', c => c.json({ ok: true }));
  app.post('/replies', c => c.json({ ok: true }));
  return app;
}

describe('threadStateGuard middleware', () => {
  test('published and unlocked thread allows reply', async () => {
    const app = buildApp(
      stubThreadAdapter({ id: 't1', status: 'published', locked: false } as Partial<Thread>),
    );
    const res = await app.request('/threads/t1/replies', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  test('locked thread returns 403', async () => {
    const app = buildApp(
      stubThreadAdapter({ id: 't1', status: 'published', locked: true } as Partial<Thread>),
    );
    const res = await app.request('/threads/t1/replies', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  test('unpublished thread returns 404', async () => {
    const app = buildApp(
      stubThreadAdapter({ id: 't1', status: 'draft', locked: false } as Partial<Thread>),
    );
    const res = await app.request('/threads/t1/replies', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('missing thread returns 404', async () => {
    const app = buildApp(stubThreadAdapter(null));
    const res = await app.request('/threads/t1/replies', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('body-scoped reply creation checks threadId from JSON body', async () => {
    const app = buildApp(
      stubThreadAdapter({ id: 't1', status: 'published', locked: false } as Partial<Thread>),
    );
    const res = await app.request('/replies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 't1' }),
    });
    expect(res.status).toBe(200);
  });

  test('body-scoped reply creation blocks locked thread', async () => {
    const app = buildApp(
      stubThreadAdapter({ id: 't1', status: 'published', locked: true } as Partial<Thread>),
    );
    const res = await app.request('/replies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 't1' }),
    });
    expect(res.status).toBe(403);
  });
});
