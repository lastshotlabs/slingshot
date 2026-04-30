import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { PermissionEvaluator } from '@lastshotlabs/slingshot-core';
import { createBroadcastGuardMiddleware } from '../../../src/middleware/broadcastGuard';
import type { Room, RoomAdapter } from '../../../src/types';
import { setVar } from './_helpers';

function stubRoomAdapter(rooms: Map<string, Partial<Room>>): RoomAdapter {
  return {
    async getById(id: string) {
      return (rooms.get(id) as Room) ?? null;
    },
  } as unknown as RoomAdapter;
}

function stubEvaluator(canManage: boolean): PermissionEvaluator {
  return {
    async can() {
      return canManage;
    },
  } as unknown as PermissionEvaluator;
}

function buildApp(rooms: Map<string, Partial<Room>>, canManage: boolean, actorId?: string | null) {
  const app = new Hono();
  if (actorId !== undefined) {
    app.use('*', async (c, next) => {
      if (actorId) {
        setVar(c, 'actor', { id: actorId, kind: 'user', roles: [], tenantId: null });
      }
      await next();
    });
  }
  app.use(
    '*',
    createBroadcastGuardMiddleware({
      roomAdapter: stubRoomAdapter(rooms),
      evaluator: stubEvaluator(canManage),
      tenantId: 'default',
    }),
  );
  app.post('/messages', c => c.json({ ok: true }));
  return app;
}

async function post(app: ReturnType<typeof buildApp>, body: unknown) {
  return app.request('/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('broadcastGuard middleware', () => {
  test('blocks non-admin sends in broadcast rooms with 403', async () => {
    const rooms = new Map<string, Partial<Room>>([['room-1', { id: 'room-1', type: 'broadcast' }]]);
    const app = buildApp(rooms, false, 'user-1');
    const res = await post(app, { roomId: 'room-1', body: 'hello' });
    expect(res.status).toBe(403);
  });

  test('allows admin sends in broadcast rooms', async () => {
    const rooms = new Map<string, Partial<Room>>([['room-1', { id: 'room-1', type: 'broadcast' }]]);
    const app = buildApp(rooms, true, 'admin-1');
    const res = await post(app, { roomId: 'room-1', body: 'hello' });
    expect(res.status).toBe(200);
  });

  test('passes through for non-broadcast rooms', async () => {
    const rooms = new Map<string, Partial<Room>>([['room-1', { id: 'room-1', type: 'group' }]]);
    const app = buildApp(rooms, false, 'user-1');
    const res = await post(app, { roomId: 'room-1', body: 'hello' });
    expect(res.status).toBe(200);
  });

  test('passes through when roomId is not in body', async () => {
    const rooms = new Map<string, Partial<Room>>();
    const app = buildApp(rooms, false, 'user-1');
    const res = await post(app, { body: 'hello' });
    expect(res.status).toBe(200);
  });

  test('passes through when room is not found', async () => {
    const rooms = new Map<string, Partial<Room>>();
    const app = buildApp(rooms, false, 'user-1');
    const res = await post(app, { roomId: 'nonexistent', body: 'hello' });
    expect(res.status).toBe(200);
  });

  test('returns 401 when no actor is set on a broadcast room', async () => {
    const rooms = new Map<string, Partial<Room>>([['room-1', { id: 'room-1', type: 'broadcast' }]]);
    const app = buildApp(rooms, false, null);
    const res = await post(app, { roomId: 'room-1', body: 'hello' });
    expect(res.status).toBe(401);
  });
});
