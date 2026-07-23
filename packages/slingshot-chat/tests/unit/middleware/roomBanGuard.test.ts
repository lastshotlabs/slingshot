import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createRoomBanGuardMiddleware } from '../../../src/middleware/roomBanGuard';
import type { RoomBanAdapter } from '../../../src/types';

function appWith(ban: Record<string, unknown> | null) {
  const app = new Hono();
  const adapter = { findByRoomUser: async () => ban } as unknown as RoomBanAdapter;
  app.use('*', createRoomBanGuardMiddleware({ banAdapter: adapter, now: () => 100_000 }));
  app.post('/members', c => c.json({ ok: true }, 201));
  return app;
}
const post = (app: Hono) =>
  app.request('/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: 'r1', userId: 'u1' }),
  });

describe('roomBanGuard', () => {
  test('rejects an active permanent ban', async () => {
    const response = await post(appWith({ id: 'b1', liftedAt: null, expiresAt: null }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'ROOM_USER_BANNED' });
  });
  test('allows absent, lifted, and expired bans', async () => {
    expect((await post(appWith(null))).status).toBe(201);
    expect((await post(appWith({ liftedAt: new Date(90_000).toISOString() }))).status).toBe(201);
    expect(
      (await post(appWith({ liftedAt: null, expiresAt: new Date(90_000).toISOString() }))).status,
    ).toBe(201);
  });
});
