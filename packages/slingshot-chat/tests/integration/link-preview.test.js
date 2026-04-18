// packages/slingshot-chat/tests/integration/link-preview.test.ts
import { describe, expect, it } from 'bun:test';
import { createChatTestApp, seedMember, seedRoom } from '../../src/testing';

const headers = userId => ({
  'x-user-id': userId,
  'content-type': 'application/json',
});
function createMockEmbeds(transform) {
  return {
    async unfurl(urls) {
      return urls
        .map(url => transform?.(url) ?? { url, title: `Preview for ${url}`, type: 'link' })
        .filter(e => e !== null);
    },
  };
}
describe('Link preview attachment', () => {
  it('attaches embeds when the message body contains a URL', async () => {
    const peersPluginState = new Map();
    peersPluginState.set('slingshot-embeds', createMockEmbeds());
    const { app, state, bus } = await createChatTestApp({}, { peersPluginState });
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const res = await app.request('/chat/messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({
        roomId: room.id,
        body: 'Check this out: https://example.com/article',
      }),
    });
    expect(res.status).toBe(201);
    const msg = await res.json();
    // Flush async event handlers (embed listener runs after message.created event)
    await bus.drain();
    const updated = await state.messages.getById(msg.id);
    expect(updated?.embeds).toHaveLength(1);
    const embed = updated?.embeds?.[0];
    expect(embed?.url).toBe('https://example.com/article');
  });
  it('attaches multiple embeds for multiple URLs in the body', async () => {
    const peersPluginState = new Map();
    peersPluginState.set('slingshot-embeds', createMockEmbeds());
    const { app, state, bus } = await createChatTestApp({}, { peersPluginState });
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const res = await app.request('/chat/messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({
        roomId: room.id,
        body: 'First: https://example.com/a  Second: https://example.com/b',
      }),
    });
    expect(res.status).toBe(201);
    const msg = await res.json();
    await bus.drain();
    const updated = await state.messages.getById(msg.id);
    expect(updated?.embeds).toHaveLength(2);
  });
  it('does not attach embeds when the body has no URLs', async () => {
    const peersPluginState = new Map();
    peersPluginState.set('slingshot-embeds', createMockEmbeds());
    const { app, state, bus } = await createChatTestApp({}, { peersPluginState });
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const res = await app.request('/chat/messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ roomId: room.id, body: 'No links here' }),
    });
    expect(res.status).toBe(201);
    const msg = await res.json();
    await bus.drain();
    const updated = await state.messages.getById(msg.id);
    // embeds field should remain absent/undefined when unfurl returns nothing
    expect(updated?.embeds == null || updated.embeds.length === 0).toBe(true);
  });
  it('skips embed attachment when slingshot-embeds is not registered', async () => {
    // No peersPluginState — embeds peer is absent
    const { app, state, bus } = await createChatTestApp();
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const res = await app.request('/chat/messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ roomId: room.id, body: 'Check https://example.com' }),
    });
    expect(res.status).toBe(201);
    const msg = await res.json();
    await bus.drain();
    const updated = await state.messages.getById(msg.id);
    // No embed provider → embeds must stay absent
    expect(updated?.embeds == null || updated.embeds.length === 0).toBe(true);
  });
  it('does not fail when the embeds provider throws', async () => {
    const failingEmbeds = {
      async unfurl(_urls) {
        throw new Error('Embeds provider unavailable');
      },
    };
    const peersPluginState = new Map();
    peersPluginState.set('slingshot-embeds', failingEmbeds);
    const { app, state, bus } = await createChatTestApp({}, { peersPluginState });
    const room = await seedRoom(state);
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });
    const res = await app.request('/chat/messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ roomId: room.id, body: 'Visit https://example.com' }),
    });
    // The message creation must succeed even if embed unfurling fails
    expect(res.status).toBe(201);
    // Drain to let the async error path settle
    await bus.drain();
    const msg = await res.json();
    const updated = await state.messages.getById(msg.id);
    // No embeds should be attached after a provider error
    expect(updated?.embeds == null || updated.embeds.length === 0).toBe(true);
  });
  it('attachEmbeds can be called directly on the message adapter', async () => {
    const { state } = await createChatTestApp();
    const room = await seedRoom(state);
    const msg = await state.messages.create({
      roomId: room.id,
      authorId: 'user-1',
      body: 'Direct embed test',
    });
    const embeds = [{ url: 'https://example.com', title: 'Example', type: 'link' }];
    const updated = await state.messages.attachEmbeds({ id: msg.id }, { embeds });
    expect(updated?.embeds).toHaveLength(1);
    expect(updated?.embeds?.[0]?.url).toBe('https://example.com');
  });
});
