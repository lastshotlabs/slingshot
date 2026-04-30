import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createArchiveGuardMiddleware } from '../../../src/middleware/archiveGuard';
import type { Room, RoomAdapter } from '../../../src/types';

function stubRoomAdapter(rooms: Map<string, Partial<Room>>): RoomAdapter {
  return {
    async getById(id: string) {
      return (rooms.get(id) as Room) ?? null;
    },
  } as unknown as RoomAdapter;
}

function buildApp(rooms: Map<string, Partial<Room>>) {
  const app = new Hono();
  app.use('*', createArchiveGuardMiddleware({ roomAdapter: stubRoomAdapter(rooms) }));
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

describe('archiveGuard middleware', () => {
  test('blocks message creation in archived rooms with 403', async () => {
    const rooms = new Map<string, Partial<Room>>([['room-1', { id: 'room-1', archived: true }]]);
    const app = buildApp(rooms);
    const res = await post(app, { roomId: 'room-1', body: 'hello' });
    expect(res.status).toBe(403);
  });

  test('allows message creation in non-archived rooms', async () => {
    const rooms = new Map<string, Partial<Room>>([['room-1', { id: 'room-1', archived: false }]]);
    const app = buildApp(rooms);
    const res = await post(app, { roomId: 'room-1', body: 'hello' });
    expect(res.status).toBe(200);
  });

  test('passes through when roomId is missing from body', async () => {
    const rooms = new Map<string, Partial<Room>>();
    const app = buildApp(rooms);
    const res = await post(app, { body: 'hello' });
    expect(res.status).toBe(200);
  });

  test('passes through when room is not found', async () => {
    const rooms = new Map<string, Partial<Room>>();
    const app = buildApp(rooms);
    const res = await post(app, { roomId: 'nonexistent', body: 'hello' });
    expect(res.status).toBe(200);
  });

  test('reads roomId from URL param when not in body', async () => {
    const rooms = new Map<string, Partial<Room>>([['room-1', { id: 'room-1', archived: true }]]);
    const adapter = stubRoomAdapter(rooms);
    const app = new Hono();
    app.use('/rooms/:roomId/messages', createArchiveGuardMiddleware({ roomAdapter: adapter }));
    app.post('/rooms/:roomId/messages', c => c.json({ ok: true }));

    const res = await app.request('/rooms/room-1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hello' }),
    });
    expect(res.status).toBe(403);
  });
});
