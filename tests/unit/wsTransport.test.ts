import { beforeEach, describe, expect, it } from 'bun:test';
import type { WsState } from '@lastshotlabs/slingshot-core';
import { publish } from '../../src/framework/ws/rooms';
import { InMemoryTransport } from '../../src/framework/ws/transport';
import type { WsTransportAdapter } from '../../src/framework/ws/transport';

const ENDPOINT = '/ws';

function createWsState(overrides?: Partial<WsState>): WsState {
  return {
    server: null,
    transport: null,
    instanceId: 'test-instance',
    presenceEnabled: false,
    roomRegistry: new Map(),
    heartbeatSockets: new Map(),
    heartbeatEndpointConfigs: new Map(),
    heartbeatTimer: null,
    socketUsers: new Map(),
    roomPresence: new Map(),
    socketRegistry: new Map(),
    rateLimitState: new Map(),
    sessionRegistry: new Map(),
    lastEventIds: new Map(),
    ...overrides,
  };
}

describe('WsTransportAdapter', () => {
  let state: WsState;

  beforeEach(() => {
    state = createWsState();
  });

  describe('InMemoryTransport', () => {
    it('can be instantiated and all methods resolve', async () => {
      const transport = new InMemoryTransport();
      expect(transport).toBeInstanceOf(InMemoryTransport);

      // Verify publish resolves
      const publishResult = transport.publish(ENDPOINT, 'room', 'message', 'origin-1');
      expect(publishResult).toBeInstanceOf(Promise);
      await expect(publishResult).resolves.toBeUndefined();

      // Verify connect resolves
      const connectResult = transport.connect(() => {});
      expect(connectResult).toBeInstanceOf(Promise);
      await expect(connectResult).resolves.toBeUndefined();

      // Verify disconnect resolves
      const disconnectResult = transport.disconnect();
      expect(disconnectResult).toBeInstanceOf(Promise);
      await expect(disconnectResult).resolves.toBeUndefined();
    });

    it('publish is a no-op', async () => {
      const transport = new InMemoryTransport();
      await transport.publish(ENDPOINT, 'room', 'message', 'origin-1');
    });

    it('connect is a no-op', async () => {
      const transport = new InMemoryTransport();
      await transport.connect(() => {});
    });

    it('disconnect is a no-op', async () => {
      const transport = new InMemoryTransport();
      await transport.disconnect();
    });
  });

  describe('publish() with transport', () => {
    it('calls both server.publish and transport.publish with origin', async () => {
      const serverCalls: { topic: string; data: string }[] = [];
      const transportCalls: { endpoint: string; room: string; message: string; origin: string }[] =
        [];

      const mockServer = {
        publish(topic: string, data: string) {
          serverCalls.push({ topic, data });
        },
      } as any;

      const mockTransport: WsTransportAdapter = {
        async publish(endpoint, room, message, origin) {
          transportCalls.push({ endpoint, room, message, origin });
        },
        async connect() {},
        async disconnect() {},
      };

      state.server = mockServer;
      state.transport = mockTransport;

      publish(state, ENDPOINT, 'lobby', { text: 'hello' });

      // Local delivery is synchronous
      expect(serverCalls).toHaveLength(1);
      expect(JSON.parse(serverCalls[0].data)).toEqual({ text: 'hello' });

      // Transport publish is async — wait a tick
      await new Promise(r => setTimeout(r, 0));
      expect(transportCalls).toHaveLength(1);
      expect(transportCalls[0].endpoint).toBe(ENDPOINT);
      expect(transportCalls[0].room).toBe('lobby');
      expect(JSON.parse(transportCalls[0].message)).toEqual({ text: 'hello' });
      // Origin must match this instance's ID
      expect(transportCalls[0].origin).toBe(state.instanceId);
    });

    it('does not call transport when none is set', () => {
      const serverCalls: string[] = [];
      const mockServer = {
        publish(topic: string) {
          serverCalls.push(topic);
        },
      } as any;

      state.server = mockServer;

      publish(state, ENDPOINT, 'room-1', { msg: 'test' });

      expect(serverCalls).toHaveLength(1);
    });

    it('catches transport publish errors without breaking local delivery', async () => {
      const serverCalls: string[] = [];
      const mockServer = {
        publish(topic: string) {
          serverCalls.push(topic);
        },
      } as any;

      const failingTransport: WsTransportAdapter = {
        async publish() {
          throw new Error('transport down');
        },
        async connect() {},
        async disconnect() {},
      };

      state.server = mockServer;
      state.transport = failingTransport;

      publish(state, ENDPOINT, 'room-1', { msg: 'test' });

      expect(serverCalls).toHaveLength(1);
      await new Promise(r => setTimeout(r, 0));
    });
  });

  describe('self-echo prevention', () => {
    it('skips inbound messages from the same instance', async () => {
      const serverCalls: string[] = [];
      const mockServer = {
        publish(topic: string) {
          serverCalls.push(topic);
        },
      } as any;

      const localId = state.instanceId;
      let capturedOnMessage:
        | ((endpoint: string, room: string, message: string, origin: string) => void)
        | null = null;

      const transport: WsTransportAdapter = {
        async publish() {},
        async connect(onMessage) {
          capturedOnMessage = onMessage;
        },
        async disconnect() {},
      };

      state.server = mockServer;
      state.transport = transport;

      // Simulate server.ts connect wiring (with self-echo guard)
      await transport.connect((endpoint, room, msg, origin) => {
        if (origin === localId) return; // self-echo guard
        mockServer.publish(room, msg);
      });

      // Simulate inbound message from THIS instance (self-echo)
      capturedOnMessage!(ENDPOINT, 'lobby', 'test-msg', localId);
      expect(serverCalls).toHaveLength(0); // should NOT deliver

      // Simulate inbound message from ANOTHER instance
      capturedOnMessage!(ENDPOINT, 'lobby', 'test-msg', 'other-instance-id');
      expect(serverCalls).toHaveLength(1); // SHOULD deliver
    });

    it('delivers inbound messages from other instances', async () => {
      const serverCalls: { topic: string; data: string }[] = [];
      const mockServer = {
        publish(topic: string, data: string) {
          serverCalls.push({ topic, data });
        },
      } as any;

      let capturedOnMessage:
        | ((endpoint: string, room: string, message: string, origin: string) => void)
        | null = null;
      const transport: WsTransportAdapter = {
        async publish() {},
        async connect(onMessage) {
          capturedOnMessage = onMessage;
        },
        async disconnect() {},
      };

      state.server = mockServer;

      // Wire with self-echo guard (mimics server.ts)
      const localId = state.instanceId;
      await transport.connect((endpoint, room, msg, origin) => {
        if (origin === localId) return;
        mockServer.publish(room, msg);
      });

      capturedOnMessage!(
        ENDPOINT,
        'lobby',
        JSON.stringify({ text: 'from-instance-2' }),
        'instance-2',
      );

      expect(serverCalls).toHaveLength(1);
      expect(serverCalls[0].topic).toBe('lobby');
      expect(JSON.parse(serverCalls[0].data)).toEqual({ text: 'from-instance-2' });
    });
  });
});
