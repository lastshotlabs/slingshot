import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { ReplyAdapter, ThreadAdapter } from '../../../src/entities/runtime';
import { createContentTargetGuardMiddleware } from '../../../src/middleware/contentTargetGuard';
import type { Reply, Thread } from '../../../src/types/models';

function stubAdapters(thread: Partial<Thread> | null, reply: Partial<Reply> | null = null) {
  return {
    threadAdapter: { getById: async () => (thread as Thread) ?? null } as unknown as ThreadAdapter,
    replyAdapter: { getById: async () => (reply as Reply) ?? null } as unknown as ReplyAdapter,
  };
}

const PUBLISHED: Partial<Thread> = { id: 't1', status: 'published', containerId: 'c1' };

/**
 * The GET cases are the regression. Before the param-first lookup the guard
 * called `c.req.json()` unconditionally, so every one of them returned
 * `400 Invalid JSON body` — which is why `Reaction.listByTarget`
 * (`GET /community/reactions/list-by-target/:targetId/:targetType`) never
 * worked in a consumer app and every feed row rendered a zero count.
 */
describe('contentTargetGuard middleware', () => {
  function paramApp(options?: Parameters<typeof createContentTargetGuardMiddleware>[1]) {
    const app = new Hono();
    app.use(
      '/reactions/list-by-target/:targetId/:targetType',
      createContentTargetGuardMiddleware(stubAdapters(PUBLISHED), options),
    );
    app.get('/reactions/list-by-target/:targetId/:targetType', c => c.json({ items: [] }));
    return app;
  }

  test('GET with the target in path params passes — no body required', async () => {
    const res = await paramApp().request('/reactions/list-by-target/t1/thread');
    expect(res.status).toBe(200);
  });

  test('GET still passes when requireContainerIdMatch is set', async () => {
    // This is the option `targetVisibilityGuard` is actually constructed with,
    // so a fix that only skipped the body parse would still 400 here.
    const res = await paramApp({ requireContainerIdMatch: true }).request(
      '/reactions/list-by-target/t1/thread',
    );
    expect(res.status).toBe(200);
  });

  test('GET for a draft target is still hidden as 404', async () => {
    const app = new Hono();
    app.use(
      '/reactions/list-by-target/:targetId/:targetType',
      createContentTargetGuardMiddleware(
        stubAdapters({ id: 't1', status: 'draft', containerId: 'c1' }),
      ),
    );
    app.get('/reactions/list-by-target/:targetId/:targetType', c => c.json({ items: [] }));
    const res = await app.request('/reactions/list-by-target/t1/thread');
    expect(res.status).toBe(404);
  });

  test('GET with an unsupported targetType is rejected', async () => {
    const res = await paramApp().request('/reactions/list-by-target/t1/banana');
    expect(res.status).toBe(400);
  });

  function bodyApp(options?: Parameters<typeof createContentTargetGuardMiddleware>[1]) {
    const app = new Hono();
    app.use('/reactions', createContentTargetGuardMiddleware(stubAdapters(PUBLISHED), options));
    app.post('/reactions', c => c.json({ ok: true }));
    return app;
  }

  const post = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  test('POST still reads the target from the body', async () => {
    const res = await bodyApp().request(
      '/reactions',
      post({ targetId: 't1', targetType: 'thread' }),
    );
    expect(res.status).toBe(200);
  });

  test('POST still enforces the containerId match', async () => {
    const app = bodyApp({ requireContainerIdMatch: true });
    const ok = await app.request(
      '/reactions',
      post({ targetId: 't1', targetType: 'thread', containerId: 'c1' }),
    );
    expect(ok.status).toBe(200);

    const mismatch = await app.request(
      '/reactions',
      post({ targetId: 't1', targetType: 'thread', containerId: 'other' }),
    );
    expect(mismatch.status).toBe(400);

    const missing = await app.request('/reactions', post({ targetId: 't1', targetType: 'thread' }));
    expect(missing.status).toBe(400);
  });

  test('POST with no body is still a 400', async () => {
    const res = await bodyApp().request('/reactions', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});
