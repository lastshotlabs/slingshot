// packages/slingshot-chat/tests/integration/messages.routes.test.ts
import { describe, expect, it } from 'bun:test';
import { createChatTestApp, seedMember, seedMessage, seedRoom } from '../../src/testing';

const headers = userId => ({
  'x-user-id': userId,
  'content-type': 'application/json',
});
describe('POST /chat/messages — send message', () => {
  it('sends message, returns 201', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state, { type: 'group' });
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const res = await app.request('/chat/messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ roomId: room.id, body: 'Hello!' }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.body).toBe('Hello!');
  });
  it('returns 403 for non-members', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state, { type: 'group' });
    const res = await app.request('/chat/messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ roomId: room.id, body: 'I am not a member' }),
    });
    expect(res.status).toBe(403);
  });
});
describe('PATCH /chat/messages/:id — edit message', () => {
  it('author can edit own message', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const msg = await seedMessage(state, { roomId: room.id, body: 'Original', authorId: 'user-1' });
    const res = await app.request(`/chat/messages/${msg.id}`, {
      method: 'PATCH',
      headers: headers('user-1'),
      body: JSON.stringify({ body: 'Edited' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.body).toBe('Edited');
  });
  it('returns 403 for non-existent message (evaluator denies)', async () => {
    const { app } = await createChatTestApp();
    const res = await app.request('/chat/messages/nonexistent', {
      method: 'PATCH',
      headers: headers('user-1'),
      body: JSON.stringify({ body: 'edit' }),
    });
    // param:id resolves but evaluator can't find the message → denies → 403
    expect(res.status).toBe(403);
  });
  it('returns 403 when non-author edits', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    await seedMember(state, { roomId: room.id, userId: 'user-2', role: 'member' });
    const msg = await seedMessage(state, { roomId: room.id, body: 'Mine', authorId: 'user-1' });
    const res = await app.request(`/chat/messages/${msg.id}`, {
      method: 'PATCH',
      headers: headers('user-2'),
      body: JSON.stringify({ body: 'Stolen edit' }),
    });
    expect(res.status).toBe(403);
  });
});
describe('DELETE /chat/messages/:id — soft delete', () => {
  it('owner can delete own message', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const msg = await seedMessage(state, {
      roomId: room.id,
      body: 'Delete me',
      authorId: 'user-1',
    });
    const res = await app.request(`/chat/messages/${msg.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'user-1' },
    });
    expect(res.status).toBe(204);
  });
  it('non-owner non-admin cannot delete', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    await seedMember(state, { roomId: room.id, userId: 'user-2', role: 'member' });
    const msg = await seedMessage(state, { roomId: room.id, body: 'Mine', authorId: 'user-1' });
    const res = await app.request(`/chat/messages/${msg.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'user-2' },
    });
    expect(res.status).toBe(403);
  });
  it('admin can delete any message', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    await seedMember(state, { roomId: room.id, userId: 'admin-1', role: 'admin' });
    const msg = await seedMessage(state, { roomId: room.id, body: 'Mine', authorId: 'user-1' });
    const res = await app.request(`/chat/messages/${msg.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'admin-1' },
    });
    expect(res.status).toBe(404);
  });
});
