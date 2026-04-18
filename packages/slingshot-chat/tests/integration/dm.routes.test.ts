// packages/slingshot-chat/tests/integration/dm.routes.test.ts
import { describe, expect, it } from 'bun:test';
import { createChatTestApp } from '../../src/testing';

describe('POST /chat/rooms/find-or-create-dm', () => {
  it('creates a DM room with deterministic ID', async () => {
    const { app } = await createChatTestApp();
    const res = await app.request('/chat/rooms/find-or-create-dm', {
      method: 'POST',
      headers: { 'x-user-id': 'user-a', 'content-type': 'application/json' },
      body: JSON.stringify({ targetUserId: 'user-b' }),
    });
    expect(res.status).toBe(200);
    const { room } = (await res.json()) as { room: { id: string; type: string } };
    expect(room.type).toBe('dm');
    expect(room.id).toBe('dm-user-a-user-b');
  });

  it('is idempotent — returns same room on second call', async () => {
    const { app } = await createChatTestApp();
    const body = JSON.stringify({ targetUserId: 'user-b' });
    const opts = {
      method: 'POST',
      headers: { 'x-user-id': 'user-a', 'content-type': 'application/json' },
      body,
    };

    const res1 = await app.request('/chat/rooms/find-or-create-dm', opts);
    const res2 = await app.request('/chat/rooms/find-or-create-dm', opts);

    const { room: room1 } = (await res1.json()) as { room: { id: string } };
    const { room: room2 } = (await res2.json()) as { room: { id: string } };
    expect(room1.id).toBe(room2.id);
  });

  it('adds both users as members', async () => {
    const { app, state } = await createChatTestApp();
    await app.request('/chat/rooms/find-or-create-dm', {
      method: 'POST',
      headers: { 'x-user-id': 'user-a', 'content-type': 'application/json' },
      body: JSON.stringify({ targetUserId: 'user-b' }),
    });

    const roomId = 'dm-user-a-user-b';
    const memberA = await state.members.findMember({ roomId, userId: 'user-a' });
    const memberB = await state.members.findMember({ roomId, userId: 'user-b' });
    expect(memberA).not.toBeNull();
    expect(memberB).not.toBeNull();
  });

  it('returns 403 when target has blocked initiator', async () => {
    const { app, state } = await createChatTestApp();
    await state.blocks.create({ blockerId: 'user-b', blockedId: 'user-a' });

    const res = await app.request('/chat/rooms/find-or-create-dm', {
      method: 'POST',
      headers: { 'x-user-id': 'user-a', 'content-type': 'application/json' },
      body: JSON.stringify({ targetUserId: 'user-b' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 when initiator has blocked target', async () => {
    const { app, state } = await createChatTestApp();
    await state.blocks.create({ blockerId: 'user-a', blockedId: 'user-b' });

    const res = await app.request('/chat/rooms/find-or-create-dm', {
      method: 'POST',
      headers: { 'x-user-id': 'user-a', 'content-type': 'application/json' },
      body: JSON.stringify({ targetUserId: 'user-b' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 400 when DMing yourself', async () => {
    const { app } = await createChatTestApp();
    const res = await app.request('/chat/rooms/find-or-create-dm', {
      method: 'POST',
      headers: { 'x-user-id': 'user-a', 'content-type': 'application/json' },
      body: JSON.stringify({ targetUserId: 'user-a' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 without auth header', async () => {
    const { app } = await createChatTestApp();
    const res = await app.request('/chat/rooms/find-or-create-dm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetUserId: 'user-b' }),
    });
    expect(res.status).toBe(401);
  });

  it('DM room ID is sorted alphabetically regardless of call order', async () => {
    const { app } = await createChatTestApp();
    const res = await app.request('/chat/rooms/find-or-create-dm', {
      method: 'POST',
      headers: { 'x-user-id': 'user-b', 'content-type': 'application/json' },
      body: JSON.stringify({ targetUserId: 'user-a' }),
    });
    expect(res.status).toBe(200);
    const { room } = (await res.json()) as { room: { id: string } };
    // user-a < user-b alphabetically
    expect(room.id).toBe('dm-user-a-user-b');
  });
});
