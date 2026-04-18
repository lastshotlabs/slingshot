// packages/slingshot-chat/tests/integration/rooms.routes.test.ts
import { describe, expect, it } from 'bun:test';
import { createChatTestApp, seedMember, seedRoom } from '../../src/testing';

const USER_1 = 'user-1';
function headers(userId, extra = {}) {
  return { 'x-user-id': userId, 'content-type': 'application/json', ...extra };
}
describe('POST /chat/rooms — create room', () => {
  it('creates a room and returns 201', async () => {
    const { app } = await createChatTestApp();
    const res = await app.request('/chat/rooms', {
      method: 'POST',
      headers: headers(USER_1),
      body: JSON.stringify({ name: 'General', type: 'group' }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.name).toBe('General');
    expect(data.type).toBe('group');
  });
  it('rejects without auth header', async () => {
    const { app } = await createChatTestApp();
    const res = await app.request('/chat/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test', type: 'group' }),
    });
    expect(res.status).toBe(401);
  });
});
describe('GET /chat/rooms/:id — get room', () => {
  it('returns room for members', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state, { name: 'General' });
    await seedMember(state, { roomId: room.id, userId: USER_1, role: 'member' });
    const res = await app.request(`/chat/rooms/${room.id}`, {
      headers: { 'x-user-id': USER_1 },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('General');
  });
  it('returns 404 for non-existent room', async () => {
    const { app } = await createChatTestApp();
    const res = await app.request('/chat/rooms/nonexistent', {
      headers: { 'x-user-id': USER_1 },
    });
    expect(res.status).toBe(404);
  });
  it('returns room for any authenticated user (no permission on get)', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state, { name: 'Open' });
    const res = await app.request(`/chat/rooms/${room.id}`, {
      headers: { 'x-user-id': 'outsider' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('Open');
  });
});
describe('PATCH /chat/rooms/:id — update room', () => {
  it('admin can update room name', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state, { name: 'Old' });
    await seedMember(state, { roomId: room.id, userId: USER_1, role: 'admin' });
    const res = await app.request(`/chat/rooms/${room.id}`, {
      method: 'PATCH',
      headers: headers(USER_1),
      body: JSON.stringify({ name: 'New Name' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('New Name');
  });
  it('non-admin member gets 403', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: USER_1, role: 'member' });
    const res = await app.request(`/chat/rooms/${room.id}`, {
      method: 'PATCH',
      headers: headers(USER_1),
      body: JSON.stringify({ name: 'New' }),
    });
    expect(res.status).toBe(403);
  });
});
describe('DELETE /chat/rooms/:id — delete room', () => {
  it('returns 401 without auth', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    const res = await app.request(`/chat/rooms/${room.id}`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});
describe('GET /chat/rooms — list rooms', () => {
  it('returns 401 without auth', async () => {
    const { app } = await createChatTestApp();
    const res = await app.request('/chat/rooms');
    expect(res.status).toBe(401);
  });
});
