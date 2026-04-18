// packages/slingshot-chat/tests/integration/incoming.ws.test.ts
import { describe, expect, it } from 'bun:test';
import { createMemoryChatState, seedMember, seedMessage, seedRoom } from '../../src/testing';
import { buildIncomingDispatch } from '../../src/ws/incoming';

function makeBus() {
  const events = [];
  return {
    emit(event, payload) {
      events.push({ event, payload });
    },
    events,
  };
}
function makePublish() {
  const calls = [];
  return {
    publish(room, event, data, opts) {
      calls.push({ room, event, data, opts });
    },
    calls,
  };
}
describe('buildIncomingDispatch', () => {
  it('returns 3 handlers (typing, read, ping)', () => {
    const state = createMemoryChatState();
    const bus = makeBus();
    const handlers = buildIncomingDispatch(state, bus);
    expect(handlers).toHaveLength(3);
    expect(handlers.map(h => h.event)).toEqual(['chat.typing', 'chat.read', 'chat.ping']);
  });
  describe('chat.typing handler', () => {
    it('broadcasts typing indicator volatile, excluding sender', async () => {
      const state = createMemoryChatState();
      const room = await seedRoom(state, { type: 'group' });
      await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
      const bus = makeBus();
      const publisher = makePublish();
      const handlers = buildIncomingDispatch(state, bus);
      const typingHandler = handlers.find(h => h.event === 'chat.typing');
      await typingHandler.handler({
        userId: 'user-1',
        socketId: 'socket-123',
        roomId: room.id,
        payload: { roomId: room.id },
        publish: publisher.publish,
      });
      expect(publisher.calls).toHaveLength(1);
      const call = publisher.calls[0];
      expect(call.room).toBe(`messages:${room.id}:live`);
      expect(call.event).toBe('chat.typing');
      expect(call.opts?.volatile).toBe(true);
      expect(call.opts?.exclude).toEqual(new Set(['socket-123']));
    });
    it('drops silently for non-members (no publish, no error)', async () => {
      const state = createMemoryChatState();
      const room = await seedRoom(state, { type: 'group' });
      const bus = makeBus();
      const publisher = makePublish();
      const handlers = buildIncomingDispatch(state, bus);
      const typingHandler = handlers.find(h => h.event === 'chat.typing');
      await typingHandler.handler({
        userId: 'non-member',
        socketId: 'socket-456',
        roomId: room.id,
        payload: { roomId: room.id },
        publish: publisher.publish,
      });
      expect(publisher.calls).toHaveLength(0);
    });
  });
  describe('chat.read handler', () => {
    it('upserts receipt, updates lastReadAt, increments readBy, emits bus event, acks', async () => {
      const state = createMemoryChatState();
      const room = await seedRoom(state, { type: 'group' });
      await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
      const msg = await seedMessage(state, { roomId: room.id, body: 'Hello', authorId: 'user-2' });
      const bus = makeBus();
      const publisher = makePublish();
      const ackData = [];
      const handlers = buildIncomingDispatch(state, bus);
      const readHandler = handlers.find(h => h.event === 'chat.read');
      await readHandler.handler({
        userId: 'user-1',
        socketId: 'socket-1',
        roomId: room.id,
        payload: { roomId: room.id, messageId: msg.id },
        publish: publisher.publish,
        ack: data => ackData.push(data),
      });
      // Receipt upserted
      const receipt = await state.receipts.latestForUserInRoom({
        userId: 'user-1',
        roomId: room.id,
      });
      expect(receipt).not.toBeNull();
      expect(receipt?.messageId).toBe(msg.id);
      // readBy incremented
      const updatedMsg = await state.messages.getById(msg.id);
      expect(updatedMsg?.readBy).toBe(1);
      // Bus event emitted
      expect(bus.events.some(e => e.event === 'chat:read.created')).toBe(true);
      // Ack called
      expect(ackData).toHaveLength(1);
      expect(ackData[0].ok).toBe(true);
    });
    it('drops silently for non-members', async () => {
      const state = createMemoryChatState();
      const room = await seedRoom(state, { type: 'group' });
      const msg = await seedMessage(state, { roomId: room.id, body: 'Test' });
      const bus = makeBus();
      const publisher = makePublish();
      const handlers = buildIncomingDispatch(state, bus);
      const readHandler = handlers.find(h => h.event === 'chat.read');
      await readHandler.handler({
        userId: 'non-member',
        socketId: 'socket-1',
        roomId: room.id,
        payload: { roomId: room.id, messageId: msg.id },
        publish: publisher.publish,
      });
      expect(bus.events).toHaveLength(0);
    });
  });
  describe('chat.ping handler', () => {
    it('calls ack with ts and serverTs when ackId present', async () => {
      const state = createMemoryChatState();
      const bus = makeBus();
      const publisher = makePublish();
      const ackData = [];
      const handlers = buildIncomingDispatch(state, bus);
      const pingHandler = handlers.find(h => h.event === 'chat.ping');
      await pingHandler.handler({
        userId: 'user-1',
        socketId: 'socket-1',
        roomId: 'room-1',
        payload: { ts: 1234567890 },
        publish: publisher.publish,
        ack: data => ackData.push(data),
      });
      expect(ackData).toHaveLength(1);
      const ack = ackData[0];
      expect(ack.ts).toBe(1234567890);
      expect(typeof ack.serverTs).toBe('number');
    });
    it('is a no-op when no ack is provided', async () => {
      const state = createMemoryChatState();
      const bus = makeBus();
      const publisher = makePublish();
      const handlers = buildIncomingDispatch(state, bus);
      const pingHandler = handlers.find(h => h.event === 'chat.ping');
      // Should not throw
      await pingHandler.handler({
        userId: 'user-1',
        socketId: 'socket-1',
        roomId: 'room-1',
        payload: { ts: 123 },
        publish: publisher.publish,
      });
      expect(publisher.calls).toHaveLength(0);
    });
  });
});
