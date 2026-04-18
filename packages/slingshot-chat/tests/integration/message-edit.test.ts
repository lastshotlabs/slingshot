// packages/slingshot-chat/tests/integration/message-edit.test.ts
import { describe, expect, it } from 'bun:test';
import { createChatTestApp, seedMember, seedMessage, seedRoom } from '../../src/testing';

const headers = (userId: string) => ({
  'x-user-id': userId,
  'content-type': 'application/json',
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
    const data = (await res.json()) as { body: string; editedAt: string | null };
    expect(data.body).toBe('Edited');
    expect(data.editedAt).not.toBeNull();
  });

  it('sets editedAt timestamp on edit', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const msg = await seedMessage(state, { roomId: room.id, body: 'Before', authorId: 'user-1' });

    // Verify editedAt starts null
    expect(msg.editedAt).toBeUndefined();

    await app.request(`/chat/messages/${msg.id}`, {
      method: 'PATCH',
      headers: headers('user-1'),
      body: JSON.stringify({ body: 'After' }),
    });

    const updated = await state.messages.getById(msg.id);
    expect(updated?.editedAt).toBeDefined();
    expect(updated?.body).toBe('After');
  });

  it('returns 403 for non-existent message (permission check fails)', async () => {
    const { app } = await createChatTestApp();
    const res = await app.request('/chat/messages/nonexistent', {
      method: 'PATCH',
      headers: headers('user-1'),
      body: JSON.stringify({ body: 'edit' }),
    });
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

  it('returns 403 when editing a deleted message (permission check fails)', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const msg = await seedMessage(state, {
      roomId: room.id,
      body: 'Delete me',
      authorId: 'user-1',
    });

    // Soft-delete the message first
    await app.request(`/chat/messages/${msg.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'user-1' },
    });

    const res = await app.request(`/chat/messages/${msg.id}`, {
      method: 'PATCH',
      headers: headers('user-1'),
      body: JSON.stringify({ body: 'Too late' }),
    });
    // Soft-deleted → evaluator.can reads message via getById → null → returns false → 403
    expect(res.status).toBe(403);
  });
});
