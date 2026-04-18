// packages/slingshot-chat/tests/integration/reminders.test.ts
import { describe, expect, it } from 'bun:test';
import { createChatTestApp, seedMember, seedRoom } from '../../src/testing';

const headers = userId => ({
  'x-user-id': userId,
  'content-type': 'application/json',
});
describe('Reminders', () => {
  it('creates a reminder via HTTP', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const triggerAt = new Date(Date.now() + 3_600_000).toISOString();
    const res = await app.request('/chat/reminders', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ roomId: room.id, triggerAt, note: 'Follow up' }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.userId).toBe('user-1');
    expect(data.roomId).toBe(room.id);
    expect(data.triggered).toBe(false);
    expect(data.note).toBe('Follow up');
  });
  it('requires auth to create a reminder', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    const res = await app.request('/chat/reminders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: room.id, triggerAt: new Date().toISOString() }),
    });
    expect(res.status).toBe(401);
  });
  it('claimDueReminders triggers past-due reminders', async () => {
    const { state } = await createChatTestApp();
    const room = await seedRoom(state);
    const reminder = await state.reminders.create({
      userId: 'user-1',
      roomId: room.id,
      triggerAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(reminder.triggered).toBe(false);
    const claimed = await state.reminders.claimDueReminders({ limit: 10 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(reminder.id);
    const updated = await state.reminders.getById(reminder.id);
    expect(updated?.triggered).toBe(true);
  });
  it('claimDueReminders does not trigger future reminders', async () => {
    const { state } = await createChatTestApp();
    const room = await seedRoom(state);
    await state.reminders.create({
      userId: 'user-1',
      roomId: room.id,
      triggerAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const claimed = await state.reminders.claimDueReminders({ limit: 10 });
    expect(claimed).toHaveLength(0);
  });
  it('claimDueReminders does not re-trigger already-triggered reminders', async () => {
    const { state } = await createChatTestApp();
    const room = await seedRoom(state);
    const reminder = await state.reminders.create({
      userId: 'user-1',
      roomId: room.id,
      triggerAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await state.reminders.update(reminder.id, { triggered: true });
    const claimed = await state.reminders.claimDueReminders({ limit: 10 });
    expect(claimed).toHaveLength(0);
  });
  it('listPending returns untriggered reminders scoped to the requesting user', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    const triggerAt = new Date(Date.now() + 3_600_000).toISOString();
    await state.reminders.create({ userId: 'user-1', roomId: room.id, triggerAt });
    await state.reminders.create({ userId: 'user-1', roomId: room.id, triggerAt });
    // Reminder for a different user — must not appear in user-1's list
    await state.reminders.create({ userId: 'user-2', roomId: room.id, triggerAt });
    const res = await app.request('/chat/reminders/list-pending', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items.length).toBe(2);
    expect(data.items.every(r => r.userId === 'user-1')).toBe(true);
    expect(data.items.every(r => r.triggered === false)).toBe(true);
  });
  it('listPending excludes already-triggered reminders', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    const triggerAt = new Date(Date.now() - 60_000).toISOString();
    const reminder = await state.reminders.create({
      userId: 'user-1',
      roomId: room.id,
      triggerAt,
    });
    await state.reminders.update(reminder.id, { triggered: true });
    const res = await app.request('/chat/reminders/list-pending', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(0);
  });
  it('deletes a reminder', async () => {
    const { app, state } = await createChatTestApp();
    const room = await seedRoom(state);
    const reminder = await state.reminders.create({
      userId: 'user-1',
      roomId: room.id,
      triggerAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const res = await app.request(`/chat/reminders/${reminder.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'user-1' },
    });
    expect(res.status).toBe(204);
    const exists = await state.reminders.getById(reminder.id);
    expect(exists).toBeNull();
  });
});
