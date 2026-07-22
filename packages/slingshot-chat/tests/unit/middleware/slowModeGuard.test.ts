import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createSlowModeGuardMiddleware } from '../../../src/middleware/slowModeGuard';
import type { MessageAdapter, RoomAdapter } from '../../../src/types';
import { setVar } from './_helpers';

function buildApp(interval: number, createdAt?: string, olderCreatedAt?: string) {
  const roomAdapter = { getById: async () => ({ id: 'room-1', slowModeSeconds: interval }) } as unknown as RoomAdapter;
  const messageAdapter = {
    listByRoom: async () => ({ items: [
      ...(olderCreatedAt ? [{ authorId: 'user-1', createdAt: olderCreatedAt }] : []),
      ...(createdAt ? [{ authorId: 'user-1', createdAt }] : []),
    ], hasMore: false }),
  } as unknown as MessageAdapter;
  const app = new Hono();
  app.use('*', async (c, next) => { setVar(c, 'actor', { kind: 'user', id: 'user-1', tenantId: null, claims: {} }); await next(); });
  app.use('*', createSlowModeGuardMiddleware({ roomAdapter, messageAdapter, now: () => 100_000 }));
  app.post('/messages', c => c.json({ ok: true }));
  return app;
}

const post = (app: ReturnType<typeof buildApp>) => app.request('/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ roomId: 'room-1', body: 'hello' }),
});

describe('slowModeGuard middleware', () => {
  test('rejects a repeated message with retry timing', async () => {
    const response = await post(buildApp(30, new Date(90_000).toISOString(), new Date(10_000).toISOString()));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('20');
  });

  test('allows posting once the interval has elapsed', async () => {
    expect((await post(buildApp(10, new Date(80_000).toISOString()))).status).toBe(200);
  });

  test('allows posting when slow mode is disabled or no prior message exists', async () => {
    expect((await post(buildApp(0, new Date(99_000).toISOString()))).status).toBe(200);
    expect((await post(buildApp(60))).status).toBe(200);
  });

  test('tracks the accepted message immediately for the next request', async () => {
    const app = buildApp(10);
    expect((await post(app)).status).toBe(200);
    expect((await post(app)).status).toBe(429);
  });
});
