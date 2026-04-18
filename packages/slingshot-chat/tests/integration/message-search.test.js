// packages/slingshot-chat/tests/integration/message-search.test.ts
import { describe, expect, it } from 'bun:test';
import { createChatTestApp, seedMember, seedMessage, seedRoom } from '../../src/testing';

const headers = userId => ({
  'x-user-id': userId,
  'content-type': 'application/json',
});
describe('Message search — POST /chat/messages/search-messages', () => {
  it('finds messages containing the query string', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    await seedMessage(state, { roomId: room.id, body: 'Hello world', authorId: 'user-1' });
    await seedMessage(state, { roomId: room.id, body: 'Goodbye world', authorId: 'user-1' });
    await seedMessage(state, { roomId: room.id, body: 'Something unrelated', authorId: 'user-1' });
    const res = await app.request('/chat/messages/search-messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ q: 'world', roomId: room.id }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(2);
    expect(data.items.every(m => m.body.includes('world'))).toBe(true);
  });
  it('is case-insensitive', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    await seedMessage(state, { roomId: room.id, body: 'Hello WORLD', authorId: 'user-1' });
    const res = await app.request('/chat/messages/search-messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ q: 'hello', roomId: room.id }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(1);
  });
  it('filters results to the specified room', async () => {
    const { app, state } = await createChatTestApp();
    const roomA = await seedRoom(state);
    const roomB = await seedRoom(state);
    await seedMember(state, { roomId: roomA.id, userId: 'user-1', role: 'member' });
    await seedMessage(state, { roomId: roomA.id, body: 'Hello in room A', authorId: 'user-1' });
    await seedMessage(state, { roomId: roomB.id, body: 'Hello in room B', authorId: 'user-1' });
    const res = await app.request('/chat/messages/search-messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ q: 'Hello', roomId: roomA.id }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(1);
    expect(data.items[0]?.roomId).toBe(roomA.id);
  });
  it('returns empty items when no messages match the query', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    await seedMessage(state, { roomId: room.id, body: 'Hello world', authorId: 'user-1' });
    const res = await app.request('/chat/messages/search-messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ q: 'xyzzy_no_match', roomId: room.id }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(0);
  });
  it('does not return soft-deleted messages', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const msg = await seedMessage(state, {
      roomId: room.id,
      body: 'Delete me please',
      authorId: 'user-1',
    });
    // Soft-delete by setting deletedAt
    await state.messages.update(msg.id, { deletedAt: new Date().toISOString() });
    const res = await app.request('/chat/messages/search-messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ q: 'Delete me', roomId: room.id }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(0);
  });
  it('returns paginated results with hasMore and nextCursor', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    for (let i = 0; i < 5; i++) {
      await seedMessage(state, {
        roomId: room.id,
        body: `Paginated message ${i}`,
        authorId: 'user-1',
      });
    }
    const res = await app.request('/chat/messages/search-messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ q: 'Paginated', roomId: room.id, limit: 2 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(2);
    expect(data.hasMore).toBe(true);
    expect(data.nextCursor).toBeDefined();
  });
  it('returns 401 without an auth header', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    const res = await app.request('/chat/messages/search-messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'hello', roomId: room.id }),
    });
    expect(res.status).toBe(401);
  });
});
