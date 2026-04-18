// packages/slingshot-chat/tests/integration/management.routes.test.ts
import { describe, expect, it } from 'bun:test';
import { createChatTestApp, seedMember, seedMessage, seedRoom } from '../../src/testing';

const headers = userId => ({
  'x-user-id': userId,
  'content-type': 'application/json',
});
describe('Blocks — /chat/blocks', () => {
  it('POST /chat/blocks — creates a block', async () => {
    const { app } = await createChatTestApp();
    const res = await app.request('/chat/blocks', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ blockerId: 'user-1', blockedId: 'user-2' }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.blockerId).toBe('user-1');
    expect(data.blockedId).toBe('user-2');
  });
  it('DELETE /chat/blocks/:id — deletes a block', async () => {
    const { app, state } = await createChatTestApp();
    const block = await state.blocks.create({ blockerId: 'user-1', blockedId: 'user-2' });
    const res = await app.request(`/chat/blocks/${block.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'user-1' },
    });
    expect(res.status).toBe(204);
    expect(await state.blocks.isBlocked({ blockerId: 'user-1', blockedId: 'user-2' })).toBe(false);
  });
  it('GET /chat/blocks — lists blocks', async () => {
    const { app, state } = await createChatTestApp();
    await state.blocks.create({ blockerId: 'user-1', blockedId: 'user-2' });
    await state.blocks.create({ blockerId: 'user-1', blockedId: 'user-3' });
    const res = await app.request('/chat/blocks', {
      headers: { 'x-user-id': 'user-1' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(2);
  });
  it('returns 401 without auth', async () => {
    const { app } = await createChatTestApp();
    const res = await app.request('/chat/blocks', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
describe('Favorites — /chat/favorite-rooms', () => {
  it('POST /chat/favorite-rooms — favorites a room', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    const res = await app.request('/chat/favorite-rooms', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ userId: 'user-1', roomId: room.id }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.userId).toBe('user-1');
    expect(data.roomId).toBe(room.id);
  });
  it('DELETE /chat/favorite-rooms/:id — unfavorites', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    const fav = await state.favorites.create({ userId: 'user-1', roomId: room.id });
    const res = await app.request(`/chat/favorite-rooms/${fav.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'user-1' },
    });
    expect(res.status).toBe(204);
    expect(await state.favorites.isFavorite({ userId: 'user-1', roomId: room.id })).toBe(false);
  });
  it('GET /chat/favorite-rooms — lists favorites', async () => {
    const { app, state } = await createChatTestApp();
    const room1 = await seedRoom(state, { name: 'Fav 1' });
    const room2 = await seedRoom(state, { name: 'Fav 2' });
    await state.favorites.create({ userId: 'user-1', roomId: room1.id });
    await state.favorites.create({ userId: 'user-1', roomId: room2.id });
    const res = await app.request('/chat/favorite-rooms', {
      headers: { 'x-user-id': 'user-1' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(2);
  });
});
describe('Pins — /chat/pins', () => {
  it('POST /chat/pins — admin can pin a message', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'admin-1', role: 'admin' });
    const msg = await seedMessage(state, { roomId: room.id, body: 'Pin me' });
    const res = await app.request('/chat/pins', {
      method: 'POST',
      headers: headers('admin-1'),
      body: JSON.stringify({ roomId: room.id, messageId: msg.id, pinnedBy: 'admin-1' }),
    });
    expect(res.status).toBe(201);
    expect(await state.pins.isPinned({ roomId: room.id, messageId: msg.id })).toBe(true);
  });
  it('POST /chat/pins — member cannot pin (403)', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const msg = await seedMessage(state, { roomId: room.id, body: 'Pin me' });
    const res = await app.request('/chat/pins', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ roomId: room.id, messageId: msg.id, pinnedBy: 'user-1' }),
    });
    expect(res.status).toBe(403);
  });
  it('DELETE /chat/pins/:id — admin can unpin', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'admin-1', role: 'admin' });
    const msg = await seedMessage(state, { roomId: room.id, body: 'Pinned' });
    const pin = await state.pins.create({
      roomId: room.id,
      messageId: msg.id,
      pinnedBy: 'admin-1',
    });
    const res = await app.request(`/chat/pins/${pin.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'admin-1' },
    });
    expect(res.status).toBe(204);
    expect(await state.pins.isPinned({ roomId: room.id, messageId: msg.id })).toBe(false);
  });
});
