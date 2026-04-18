// packages/slingshot-chat/tests/integration/scheduled-messages.test.ts
import { describe, expect, it } from 'bun:test';
import { createChatTestApp, seedMember, seedMessage, seedRoom } from '../../src/testing';

const headers = (userId: string) => ({
  'x-user-id': userId,
  'content-type': 'application/json',
});

describe('Scheduled messages', () => {
  it('claimDueScheduledMessages delivers messages whose scheduledAt has passed', async () => {
    const { state } = await createChatTestApp();
    const room = await seedRoom(state);

    const msg = await state.messages.create({
      roomId: room.id,
      authorId: 'user-1',
      body: 'Scheduled in the past',
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      scheduledDelivered: false,
    });
    expect(msg.scheduledDelivered).toBe(false);

    const claimed = await state.messages.claimDueScheduledMessages({ limit: 10 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(msg.id);

    const updated = await state.messages.getById(msg.id);
    expect(updated?.scheduledDelivered).toBe(true);
  });

  it('does not claim future-scheduled messages', async () => {
    const { state } = await createChatTestApp();
    const room = await seedRoom(state);

    await state.messages.create({
      roomId: room.id,
      authorId: 'user-1',
      body: 'Scheduled far in the future',
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      scheduledDelivered: false,
    });

    const claimed = await state.messages.claimDueScheduledMessages({ limit: 10 });
    expect(claimed).toHaveLength(0);
  });

  it('does not claim unscheduled messages', async () => {
    const { state } = await createChatTestApp();
    const room = await seedRoom(state);

    await seedMessage(state, { roomId: room.id, body: 'Regular message' });

    const claimed = await state.messages.claimDueScheduledMessages({ limit: 10 });
    expect(claimed).toHaveLength(0);
  });

  it('does not re-claim already delivered scheduled messages', async () => {
    const { state } = await createChatTestApp();
    const room = await seedRoom(state);

    await state.messages.create({
      roomId: room.id,
      authorId: 'user-1',
      body: 'Already delivered',
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      scheduledDelivered: true,
    });

    const claimed = await state.messages.claimDueScheduledMessages({ limit: 10 });
    expect(claimed).toHaveLength(0);
  });

  it('creates a scheduled message via HTTP with scheduledDelivered false', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });

    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    const res = await app.request('/chat/messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ roomId: room.id, body: 'Scheduled message', scheduledAt }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { scheduledDelivered: boolean; scheduledAt: string };
    expect(data.scheduledDelivered).toBe(false);
    expect(data.scheduledAt).toBe(scheduledAt);
  });

  it('respects limit when claiming due messages', async () => {
    const { state } = await createChatTestApp();
    const room = await seedRoom(state);

    for (let i = 0; i < 5; i++) {
      await state.messages.create({
        roomId: room.id,
        authorId: 'user-1',
        body: `Scheduled message ${i}`,
        scheduledAt: new Date(Date.now() - 60_000).toISOString(),
        scheduledDelivered: false,
      });
    }

    const claimed = await state.messages.claimDueScheduledMessages({ limit: 3 });
    expect(claimed).toHaveLength(3);
  });
});
