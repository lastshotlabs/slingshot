import { describe, expect, it } from 'bun:test';
import { getContext } from '@lastshotlabs/slingshot-core';
import { createChatTestApp, seedMember, seedRoom } from '../../src/testing';

describe('manifest-safe bootstrap', () => {
  it('boots from JSON-only config and exposes chat routes', async () => {
    const { app, state } = await createChatTestApp({
      mountPath: '/api/chat',
      permissions: {
        createRoom: ['admin'],
      },
      encryption: {
        provider: 'none',
      },
    });

    expect(state.config.mountPath).toBe('/api/chat');
    expect(state.config.encryption).toEqual({ provider: 'none' });

    const res = await app.request('/api/chat/rooms', {
      method: 'POST',
      headers: { 'x-user-id': 'user-1', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Manifest Room', type: 'group' }),
    });

    expect(res.status).toBe(201);
  });

  it('self-wires ws incoming handlers onto the mountPath endpoint using framework dispatch signature', async () => {
    const { app, state } = await createChatTestApp();
    const ctx = getContext(app);
    const endpoint = ctx.wsEndpoints?.['/chat'];
    expect(endpoint).toBeDefined();

    const ping = endpoint?.incoming?.['chat.ping'];
    expect(ping).toBeDefined();

    const pingAck = (await ping?.handler(
      { data: { id: 'sock-ping', rooms: new Set<string>() } },
      { ts: 123 },
      {
        socketId: 'sock-ping',
        actor: { id: null, kind: 'anonymous', tenantId: null, sessionId: null, roles: null, claims: {} },
        requestTenantId: null,
        endpoint: '/chat',
        publish() {},
        subscribe() {},
        unsubscribe() {},
      },
    )) as { ts: number; serverTs: number };
    expect(pingAck.ts).toBe(123);
    expect(typeof pingAck.serverTs).toBe('number');

    const room = await seedRoom(state, { type: 'group' });
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });

    const typing = endpoint?.incoming?.['chat.typing'];
    expect(typing).toBeDefined();

    const published: Array<{ room: string; data: unknown }> = [];
    await typing?.handler(
      { data: { id: 'sock-typing', rooms: new Set([`messages:${room.id}:live`]) } },
      { roomId: room.id },
      {
        socketId: 'sock-typing',
        actor: { id: 'user-1', kind: 'user', tenantId: null, sessionId: null, roles: null, claims: {} },
        requestTenantId: null,
        endpoint: '/chat',
        publish(roomName, data) {
          published.push({ room: roomName, data });
        },
        subscribe() {},
        unsubscribe() {},
      },
    );

    expect(published).toHaveLength(1);
    expect(published[0]?.room).toBe(`messages:${room.id}:live`);
    expect(published[0]?.data).toEqual({
      event: 'chat.typing',
      userId: 'user-1',
      roomId: room.id,
    });
  });
});
