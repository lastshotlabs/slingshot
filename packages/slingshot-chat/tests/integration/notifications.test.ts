import { describe, expect, it } from 'bun:test';
import { createChatTestApp, seedMember, seedMessage, seedRoom } from '../../src/testing';

const headers = (userId: string) => ({
  'x-user-id': userId,
  'content-type': 'application/json',
});

describe('chat notifications', () => {
  it('creates mention notifications for mentioned room members', async () => {
    const { app, state, notifications } = await createChatTestApp();
    const room = await seedRoom(state, { type: 'group' });
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    await seedMember(state, { roomId: room.id, userId: 'user-2', role: 'member' });

    const res = await app.request('/chat/messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ roomId: room.id, body: 'Hello @user-2' }),
    });

    expect(res.status).toBe(201);
    const message = (await res.json()) as { id: string };
    const rows = await notifications.listByUser({ 'actor.id': 'user-2' });

    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]?.type).toBe('chat:mention');
    expect(rows.items[0]?.source).toBe('chat');
    expect(rows.items[0]?.targetId).toBe(message.id);
  });

  it('skips mention notifications when the member notify preference is none', async () => {
    const { app, state, notifications } = await createChatTestApp();
    const room = await seedRoom(state, { type: 'group' });
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    await seedMember(state, {
      roomId: room.id,
      userId: 'user-2',
      role: 'member',
      notifyOn: 'none',
    });

    const res = await app.request('/chat/messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ roomId: room.id, body: 'Hello @user-2' }),
    });

    expect(res.status).toBe(201);
    const rows = await notifications.listByUser({ 'actor.id': 'user-2' });
    expect(rows.items).toHaveLength(0);
  });

  it('creates reply notifications for the parent message author', async () => {
    const { app, state, notifications } = await createChatTestApp();
    const room = await seedRoom(state, { type: 'group' });
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    await seedMember(state, { roomId: room.id, userId: 'user-2', role: 'member' });
    const parent = await seedMessage(state, {
      roomId: room.id,
      authorId: 'user-2',
      body: 'Original message',
    });

    const res = await app.request('/chat/messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({
        roomId: room.id,
        body: 'Replying to you',
        replyToId: parent.id,
      }),
    });

    expect(res.status).toBe(201);
    const rows = await notifications.listByUser({ 'actor.id': 'user-2' });

    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]?.type).toBe('chat:reply');
    expect(rows.items[0]?.source).toBe('chat');
  });

  it('creates invite notifications when a member is added by another user', async () => {
    const { app, state, notifications } = await createChatTestApp();
    const room = await seedRoom(state, { type: 'group' });
    await seedMember(state, { roomId: room.id, userId: 'admin-1', role: 'admin' });

    const res = await app.request('/chat/room-members', {
      method: 'POST',
      headers: headers('admin-1'),
      body: JSON.stringify({ roomId: room.id, userId: 'user-2' }),
    });

    expect(res.status).toBe(201);
    const rows = await notifications.listByUser({ 'actor.id': 'user-2' });

    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]?.type).toBe('chat:invite');
    expect(rows.items[0]?.source).toBe('chat');
    expect(rows.items[0]?.targetId).toBe(room.id);
  });
});
