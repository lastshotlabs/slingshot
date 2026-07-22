import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createTimeoutGuardMiddleware } from '../../../src/middleware/timeoutGuard';
import type { RoomMemberAdapter } from '../../../src/types';
import { setVar } from './_helpers';

function buildApp(mutedUntil?: string | null) {
  const memberAdapter = {
    findMember: async () => ({ id: 'member-1', roomId: 'room-1', userId: 'user-1', mutedUntil }),
  } as unknown as RoomMemberAdapter;
  const app = new Hono();
  app.use('*', async (c, next) => {
    setVar(c, 'actor', { kind: 'user', id: 'user-1', tenantId: null, claims: {} });
    await next();
  });
  app.use('*', createTimeoutGuardMiddleware({ memberAdapter, now: () => 100_000 }));
  app.post('/messages', c => c.json({ ok: true }));
  return app;
}

const post = (app: ReturnType<typeof buildApp>) => app.request('/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ roomId: 'room-1', body: 'hello' }),
});

describe('timeoutGuard middleware', () => {
  test('rejects a timed-out member with an exact LCD countdown', async () => {
    const response = await post(buildApp(new Date(147_001).toISOString()));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('48');
    expect(await response.json()).toEqual({
      error: "YOU'RE BENCHED — 0:48",
      code: 'ROOM_MEMBER_TIMEOUT',
      remainingSeconds: 48,
    });
  });

  test('allows members whose timeout elapsed or was cleared', async () => {
    expect((await post(buildApp(new Date(99_999).toISOString()))).status).toBe(200);
    expect((await post(buildApp(null))).status).toBe(200);
    expect((await post(buildApp())).status).toBe(200);
  });

  test('allows requests without a resolvable actor or room', async () => {
    const memberAdapter = { findMember: async () => { throw new Error('not called'); } } as unknown as RoomMemberAdapter;
    const app = new Hono();
    app.use('*', createTimeoutGuardMiddleware({ memberAdapter }));
    app.post('/messages', c => c.json({ ok: true }));
    expect((await app.request('/messages', { method: 'POST', body: '{}' })).status).toBe(200);
  });
});
