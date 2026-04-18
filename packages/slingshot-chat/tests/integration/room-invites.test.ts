// packages/slingshot-chat/tests/integration/room-invites.test.ts
import { describe, expect, it } from 'bun:test';
import { createChatTestApp, seedMember, seedRoom } from '../../src/testing';

const headers = (userId: string) => ({
  'x-user-id': userId,
  'content-type': 'application/json',
});

describe('Room invites — token redemption', () => {
  it('redeems a valid token and creates a room member', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'admin-1', role: 'admin' });

    await state.invites!.create({
      roomId: room.id,
      createdBy: 'admin-1',
      token: 'valid-token-abc',
    });

    const res = await app.request('/chat/room-invites/redeem', {
      method: 'POST',
      headers: headers('user-2'),
      body: JSON.stringify({ token: 'valid-token-abc' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { alreadyMember: boolean; member: { role: string } };
    expect(data.alreadyMember).toBe(false);
    expect(data.member.role).toBe('member');

    const member = await state.members.findMember({ roomId: room.id, userId: 'user-2' });
    expect(member).not.toBeNull();
    expect(member?.role).toBe('member');
  });

  it('returns 404 for an unknown token', async () => {
    const { app } = await createChatTestApp();

    const res = await app.request('/chat/room-invites/redeem', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ token: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns alreadyMember:true when the user is already in the room', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'admin-1', role: 'admin' });
    await seedMember(state, { roomId: room.id, userId: 'user-2', role: 'member' });

    await state.invites!.create({
      roomId: room.id,
      createdBy: 'admin-1',
      token: 'rejoiner-token',
    });

    const res = await app.request('/chat/room-invites/redeem', {
      method: 'POST',
      headers: headers('user-2'),
      body: JSON.stringify({ token: 'rejoiner-token' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { alreadyMember: boolean };
    expect(data.alreadyMember).toBe(true);
  });

  it('increments useCount on each successful redemption', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'admin-1', role: 'admin' });

    const invite = await state.invites!.create({
      roomId: room.id,
      createdBy: 'admin-1',
      token: 'count-token',
    });
    expect(invite.useCount).toBe(0);

    await app.request('/chat/room-invites/redeem', {
      method: 'POST',
      headers: headers('user-2'),
      body: JSON.stringify({ token: 'count-token' }),
    });

    const updated = await state.invites!.getById(invite.id);
    expect(updated?.useCount).toBe(1);
  });
});

describe('Room invites — expiry', () => {
  it('returns 410 when the invite has expired', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);

    await state.invites!.create({
      roomId: room.id,
      createdBy: 'admin-1',
      token: 'expired-token',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const res = await app.request('/chat/room-invites/redeem', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ token: 'expired-token' }),
    });
    expect(res.status).toBe(410);
  });

  it('accepts an invite that has not yet expired', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'admin-1', role: 'admin' });

    await state.invites!.create({
      roomId: room.id,
      createdBy: 'admin-1',
      token: 'not-expired-token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const res = await app.request('/chat/room-invites/redeem', {
      method: 'POST',
      headers: headers('user-2'),
      body: JSON.stringify({ token: 'not-expired-token' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('Room invites — use-count limits', () => {
  it('returns 410 after maxUses is exhausted', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'admin-1', role: 'admin' });

    await state.invites!.create({
      roomId: room.id,
      createdBy: 'admin-1',
      token: 'one-use-token',
      maxUses: 1,
    });

    const res1 = await app.request('/chat/room-invites/redeem', {
      method: 'POST',
      headers: headers('user-2'),
      body: JSON.stringify({ token: 'one-use-token' }),
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request('/chat/room-invites/redeem', {
      method: 'POST',
      headers: headers('user-3'),
      body: JSON.stringify({ token: 'one-use-token' }),
    });
    expect(res2.status).toBe(410);
  });

  it('allows multiple redemptions when maxUses is null (unlimited)', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'admin-1', role: 'admin' });

    await state.invites!.create({
      roomId: room.id,
      createdBy: 'admin-1',
      token: 'unlimited-token',
      maxUses: null,
    });

    for (const userId of ['user-2', 'user-3', 'user-4']) {
      const res = await app.request('/chat/room-invites/redeem', {
        method: 'POST',
        headers: headers(userId),
        body: JSON.stringify({ token: 'unlimited-token' }),
      });
      expect(res.status).toBe(200);
    }
  });

  it('claimInviteSlot returns null when maxUses is reached', async () => {
    const { state } = await createChatTestApp();
    const room = await seedRoom(state);

    const invite = await state.invites!.create({
      roomId: room.id,
      createdBy: 'admin-1',
      token: 'slot-test-token',
      maxUses: 2,
    });

    // Claim both slots
    await state.invites!.claimInviteSlot({ id: invite.id });
    await state.invites!.claimInviteSlot({ id: invite.id });

    // Third claim must fail
    const result = await state.invites!.claimInviteSlot({ id: invite.id });
    expect(result).toBeNull();
  });
});

describe('Room invites — revocation', () => {
  it('returns 410 when redeeming a revoked invite', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);

    const invite = await state.invites!.create({
      roomId: room.id,
      createdBy: 'admin-1',
      token: 'to-revoke-token',
    });

    // Revoke via adapter (HTTP revokeInvite has a known scope-resolution limitation)
    await state.invites!.revokeInvite({ id: invite.id });

    const res = await app.request('/chat/room-invites/redeem', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ token: 'to-revoke-token' }),
    });
    expect(res.status).toBe(410);
  });

  it('revokeInvite sets revoked:true via adapter', async () => {
    const { state } = await createChatTestApp();
    const room = await seedRoom(state);

    const invite = await state.invites!.create({
      roomId: room.id,
      createdBy: 'admin-1',
      token: 'revoke-adapter-token',
    });
    expect(invite.revoked).toBe(false);

    const revoked = await state.invites!.revokeInvite({ id: invite.id });
    expect(revoked?.revoked).toBe(true);
  });
});

describe('Room invites — findByToken (no-auth lookup)', () => {
  it('returns invite data without requiring authentication', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);

    await state.invites!.create({
      roomId: room.id,
      createdBy: 'admin-1',
      token: 'public-token',
    });

    // No x-user-id header
    const res = await app.request('/chat/room-invites/find-by-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'public-token' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { token: string; roomId: string };
    expect(data.token).toBe('public-token');
    expect(data.roomId).toBe(room.id);
  });

  it('returns null for a non-existent token', async () => {
    const { app } = await createChatTestApp();

    const res = await app.request('/chat/room-invites/find-by-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'ghost-token' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toBeNull();
  });
});
