// packages/slingshot-chat/tests/integration/message-forwarding.test.ts
import { describe, expect, it } from 'bun:test';
import { createChatTestApp, seedMember, seedMessage, seedRoom } from '../../src/testing';

const headers = (userId: string) => ({
  'x-user-id': userId,
  'content-type': 'application/json',
});

describe('Message forwarding — POST /chat/messages/forward', () => {
  it('forwards a message to another room', async () => {
    const { app, state } = await createChatTestApp();
    const roomA = await seedRoom(state, { name: 'Source' });
    const roomB = await seedRoom(state, { name: 'Target' });
    await seedMember(state, { roomId: roomA.id, userId: 'user-1', role: 'member' });
    await seedMember(state, { roomId: roomB.id, userId: 'user-1', role: 'member' });
    const original = await seedMessage(state, {
      roomId: roomA.id,
      authorId: 'user-2',
      body: 'Original body',
    });

    const res = await app.request('/chat/messages/forward', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ messageId: original.id, targetRoomId: roomB.id }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      message: { id: string; roomId: string; body: string; forwardedFromId: string | null };
    };
    expect(data.message.roomId).toBe(roomB.id);
    expect(data.message.body).toBe('Original body');
    expect(data.message.forwardedFromId).toBe(original.id);
  });

  it('preserves the original message type', async () => {
    const { app, state } = await createChatTestApp();
    const roomA = await seedRoom(state);
    const roomB = await seedRoom(state);
    await seedMember(state, { roomId: roomA.id, userId: 'user-1', role: 'member' });
    await seedMember(state, { roomId: roomB.id, userId: 'user-1', role: 'member' });

    const imageMsg = await state.messages.create({
      roomId: roomA.id,
      authorId: 'user-2',
      body: 'https://example.com/photo.jpg',
      type: 'image',
    });

    const res = await app.request('/chat/messages/forward', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ messageId: imageMsg.id, targetRoomId: roomB.id }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { message: { type: string } };
    expect(data.message.type).toBe('image');
  });

  it('sets appMetadata.forwarded:true and records originalAuthorId', async () => {
    const { app, state } = await createChatTestApp();
    const roomA = await seedRoom(state);
    const roomB = await seedRoom(state);
    await seedMember(state, { roomId: roomA.id, userId: 'user-1', role: 'member' });
    await seedMember(state, { roomId: roomB.id, userId: 'user-1', role: 'member' });
    const original = await seedMessage(state, {
      roomId: roomA.id,
      authorId: 'original-author',
      body: 'Something important',
    });

    const res = await app.request('/chat/messages/forward', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ messageId: original.id, targetRoomId: roomB.id }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      message: { appMetadata: { forwarded: boolean; originalAuthorId: string } };
    };
    expect(data.message.appMetadata.forwarded).toBe(true);
    expect(data.message.appMetadata.originalAuthorId).toBe('original-author');
  });

  it('records the forwarding user as the new author', async () => {
    const { app, state } = await createChatTestApp();
    const roomA = await seedRoom(state);
    const roomB = await seedRoom(state);
    await seedMember(state, { roomId: roomA.id, userId: 'forwarder', role: 'member' });
    await seedMember(state, { roomId: roomB.id, userId: 'forwarder', role: 'member' });
    const original = await seedMessage(state, {
      roomId: roomA.id,
      authorId: 'original-author',
      body: 'To be forwarded',
    });

    const res = await app.request('/chat/messages/forward', {
      method: 'POST',
      headers: headers('forwarder'),
      body: JSON.stringify({ messageId: original.id, targetRoomId: roomB.id }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { message: { authorId: string } };
    expect(data.message.authorId).toBe('forwarder');
  });

  it('returns 404 when the source message does not exist', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });

    const res = await app.request('/chat/messages/forward', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ messageId: 'nonexistent-id', targetRoomId: room.id }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 403 when the user is not a member of the target room', async () => {
    const { app, state } = await createChatTestApp();
    const roomA = await seedRoom(state);
    const roomB = await seedRoom(state);
    await seedMember(state, { roomId: roomA.id, userId: 'user-1', role: 'member' });
    // user-1 is NOT in roomB
    const msg = await seedMessage(state, { roomId: roomA.id, authorId: 'user-1', body: 'Hi' });

    const res = await app.request('/chat/messages/forward', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ messageId: msg.id, targetRoomId: roomB.id }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 when the target room is archived', async () => {
    const { app, state } = await createChatTestApp();
    const roomA = await seedRoom(state);
    const roomB = await seedRoom(state, { archived: true, archivedAt: new Date().toISOString() });
    await seedMember(state, { roomId: roomA.id, userId: 'user-1', role: 'member' });
    await seedMember(state, { roomId: roomB.id, userId: 'user-1', role: 'member' });
    const msg = await seedMessage(state, { roomId: roomA.id, authorId: 'user-1', body: 'Hi' });

    const res = await app.request('/chat/messages/forward', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ messageId: msg.id, targetRoomId: roomB.id }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 401 without an auth header', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    const msg = await seedMessage(state, { roomId: room.id, body: 'Hi' });

    const res = await app.request('/chat/messages/forward', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: msg.id, targetRoomId: room.id }),
    });
    expect(res.status).toBe(401);
  });
});
