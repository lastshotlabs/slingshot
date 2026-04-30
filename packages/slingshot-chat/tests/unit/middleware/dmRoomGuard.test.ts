import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createDmRoomGuardMiddleware } from '../../../src/middleware/dmRoomGuard';
import type { Room, RoomAdapter } from '../../../src/types';

function stubRoomAdapter(rooms: Map<string, Partial<Room>>): RoomAdapter {
  return {
    async getById(id: string) {
      return (rooms.get(id) as Room) ?? null;
    },
  } as unknown as RoomAdapter;
}

function buildApp(rooms: Map<string, Partial<Room>>) {
  const adapter = stubRoomAdapter(rooms);
  const app = new Hono();
  app.use('/rooms/:roomId/members', createDmRoomGuardMiddleware({ roomAdapter: adapter }));
  app.post('/rooms/:roomId/members', c => c.json({ ok: true }));
  return app;
}

describe('dmRoomGuard middleware', () => {
  test('rejects member additions to DM rooms with 400', async () => {
    const rooms = new Map<string, Partial<Room>>([['room-1', { id: 'room-1', type: 'dm' }]]);
    const app = buildApp(rooms);
    const res = await app.request('/rooms/room-1/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'user-2' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('DM');
  });

  test('allows member additions to group rooms', async () => {
    const rooms = new Map<string, Partial<Room>>([['room-1', { id: 'room-1', type: 'group' }]]);
    const app = buildApp(rooms);
    const res = await app.request('/rooms/room-1/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'user-2' }),
    });
    expect(res.status).toBe(200);
  });

  test('allows member additions to broadcast rooms', async () => {
    const rooms = new Map<string, Partial<Room>>([['room-1', { id: 'room-1', type: 'broadcast' }]]);
    const app = buildApp(rooms);
    const res = await app.request('/rooms/room-1/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'user-2' }),
    });
    expect(res.status).toBe(200);
  });

  test('passes through when room is not found', async () => {
    const rooms = new Map<string, Partial<Room>>();
    const app = buildApp(rooms);
    const res = await app.request('/rooms/nonexistent/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'user-2' }),
    });
    expect(res.status).toBe(200);
  });

  test('reads roomId from request body when no URL param', async () => {
    const rooms = new Map<string, Partial<Room>>([['room-1', { id: 'room-1', type: 'dm' }]]);
    const adapter = stubRoomAdapter(rooms);
    const app = new Hono();
    app.use('/members', createDmRoomGuardMiddleware({ roomAdapter: adapter }));
    app.post('/members', c => c.json({ ok: true }));

    const res = await app.request('/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1', userId: 'user-2' }),
    });
    expect(res.status).toBe(400);
  });
});
