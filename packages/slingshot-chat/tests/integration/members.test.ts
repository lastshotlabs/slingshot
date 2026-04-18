// packages/slingshot-chat/tests/integration/members.test.ts
import { describe, expect, it } from 'bun:test';
import { createChatTestApp, seedMember, seedRoom } from '../../src/testing';

const headers = (userId: string) => ({
  'x-user-id': userId,
  'content-type': 'application/json',
});

describe('POST /chat/room-members — add member', () => {
  it('admin can add a member', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'admin-1', role: 'admin' });

    const res = await app.request('/chat/room-members', {
      method: 'POST',
      headers: headers('admin-1'),
      body: JSON.stringify({ roomId: room.id, userId: 'user-2' }),
    });
    expect(res.status).toBe(201);

    const member = await state.members.findMember({ roomId: room.id, userId: 'user-2' });
    expect(member).not.toBeNull();
    expect(member?.role).toBe('member');
  });

  it('returns 403 when non-admin tries to add', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });

    const res = await app.request('/chat/room-members', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ roomId: room.id, userId: 'user-2' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /chat/room-members/:id — update member', () => {
  it('admin can update member nickname', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'admin-1', role: 'admin' });
    const member = await seedMember(state, { roomId: room.id, userId: 'user-2', role: 'member' });

    const res = await app.request(`/chat/room-members/${member.id}`, {
      method: 'PATCH',
      headers: headers('admin-1'),
      body: JSON.stringify({ nickname: 'Buddy' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { nickname: string };
    expect(data.nickname).toBe('Buddy');
  });

  it('non-admin cannot update another member', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const member = await seedMember(state, { roomId: room.id, userId: 'user-2', role: 'member' });

    const res = await app.request(`/chat/room-members/${member.id}`, {
      method: 'PATCH',
      headers: headers('user-1'),
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /chat/room-members/:id — remove member', () => {
  it('admin can kick a member', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'admin-1', role: 'admin' });
    const member = await seedMember(state, { roomId: room.id, userId: 'user-2', role: 'member' });

    const res = await app.request(`/chat/room-members/${member.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'admin-1' },
    });
    expect(res.status).toBe(204);

    const found = await state.members.findMember({ roomId: room.id, userId: 'user-2' });
    expect(found).toBeNull();
  });

  it('non-admin cannot kick members', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const member = await seedMember(state, { roomId: room.id, userId: 'user-2', role: 'member' });

    const res = await app.request(`/chat/room-members/${member.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'user-1' },
    });
    expect(res.status).toBe(403);
  });
});
