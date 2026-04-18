// packages/slingshot-chat/tests/integration/reactions.test.ts
import { describe, expect, it } from 'bun:test';
import { createChatTestApp, seedMember, seedMessage, seedRoom } from '../../src/testing';

const headers = (userId: string) => ({
  'x-user-id': userId,
  'content-type': 'application/json',
});

describe('Message Reactions — /chat/message-reactions', () => {
  it('POST creates a reaction (201)', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const msg = await seedMessage(state, { roomId: room.id, body: 'React to me' });

    const res = await app.request('/chat/message-reactions', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({
        messageId: msg.id,
        roomId: room.id,
        userId: 'user-1',
        emoji: '👍',
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { emoji: string; userId: string; messageId: string };
    expect(data.emoji).toBe('👍');
    expect(data.userId).toBe('user-1');
    expect(data.messageId).toBe(msg.id);
  });

  it('DELETE removes a reaction (204)', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const msg = await seedMessage(state, { roomId: room.id, body: 'React' });

    const reaction = await state.reactions.create({
      userId: 'user-1',
      messageId: msg.id,
      roomId: room.id,
      emoji: '👍',
    });

    const res = await app.request(`/chat/message-reactions/${reaction.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'user-1' },
    });
    expect(res.status).toBe(204);

    const exists = await state.reactions.hasReacted({
      userId: 'user-1',
      messageId: msg.id,
      emoji: '👍',
    });
    expect(exists).toBe(false);
  });

  it('GET lists reactions (200)', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    const msg = await seedMessage(state, { roomId: room.id, body: 'Reacted' });

    await state.reactions.create({
      userId: 'user-1',
      messageId: msg.id,
      roomId: room.id,
      emoji: '👍',
    });
    await state.reactions.create({
      userId: 'user-2',
      messageId: msg.id,
      roomId: room.id,
      emoji: '🔥',
    });

    const res = await app.request('/chat/message-reactions', {
      headers: { 'x-user-id': 'user-1' },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { items: unknown[] };
    expect(data.items).toHaveLength(1);
  });

  it('returns 401 without auth', async () => {
    const { app } = await createChatTestApp();
    const res = await app.request('/chat/message-reactions', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
