/**
 * Tests for src/framework/ws/redisTransport.ts
 *
 * Lines to cover: 19, 23-27, 32-38, 77-81, 85, 89, 93-124, 128-142
 *
 * The transport uses require('ioredis') at runtime. We mock the module so we
 * can capture created instances and trigger synthetic events.
 */
import { describe, expect, mock, test } from 'bun:test';
import { wsEndpointKey } from '../../src/framework/ws/namespace';
// Import AFTER mock is set up
import { createRedisTransport } from '../../src/framework/ws/redisTransport';

// ---------------------------------------------------------------------------
// Inline mock Redis class that we can control per-test
// ---------------------------------------------------------------------------
type PmessageHandler = (pattern: string, channel: string, payload: string) => void;

interface MockRedisInstance {
  published: Array<{ channel: string; payload: string }>;
  subscribedPatterns: string[];
  disconnected: boolean;
  pmessageHandlers: PmessageHandler[];
  triggerPmessage(pattern: string, channel: string, payload: string): void;
  publish(channel: string, payload: string): Promise<number>;
  psubscribe(pattern: string): Promise<void>;
  on(event: string, handler: (...args: unknown[]) => unknown): MockRedisInstance;
  disconnect(): void;
}

const createdInstances: MockRedisInstance[] = [];

function createMockRedisInstance(): MockRedisInstance {
  const instance: MockRedisInstance = {
    published: [],
    subscribedPatterns: [],
    disconnected: false,
    pmessageHandlers: [],
    triggerPmessage(pattern, channel, payload) {
      for (const h of this.pmessageHandlers) h(pattern, channel, payload);
    },
    publish(channel, payload) {
      this.published.push({ channel, payload });
      return Promise.resolve(1);
    },
    psubscribe(pattern) {
      this.subscribedPatterns.push(pattern);
      return Promise.resolve();
    },
    on(event, handler) {
      if (event === 'pmessage') this.pmessageHandlers.push(handler as PmessageHandler);
      return this;
    },
    disconnect() {
      this.disconnected = true;
    },
  };
  return instance;
}

// Override ioredis with our mock class — must be called BEFORE module import
mock.module('ioredis', () => {
  function MockRedis() {
    const inst = createMockRedisInstance();
    createdInstances.push(inst);
    return inst;
  }
  MockRedis.prototype = {};
  return { default: MockRedis };
});

function clearInstances() {
  createdInstances.length = 0;
}

describe('createRedisTransport — not connected', () => {
  test('publish throws when not connected', async () => {
    clearInstances();
    const transport = createRedisTransport({ connection: { host: 'localhost', port: 6379 } });

    await expect(transport.publish('/ws', 'room', 'msg', 'origin-1')).rejects.toThrow(
      'Not connected',
    );
  });

  test('disconnect before connect is a no-op', async () => {
    clearInstances();
    const transport = createRedisTransport({ connection: 'redis://localhost:6379' });

    await expect(transport.disconnect()).resolves.toBeUndefined();
  });
});

describe('createRedisTransport — connect', () => {
  test('connect creates two ioredis instances (pub + sub)', async () => {
    clearInstances();
    const transport = createRedisTransport({ connection: 'redis://localhost:6379' });

    await transport.connect(() => {});

    // Two instances should have been created: pub and sub
    expect(createdInstances.length).toBeGreaterThanOrEqual(2);
  });

  test('connect subscribes sub client to prefix pattern', async () => {
    clearInstances();
    const transport = createRedisTransport({
      connection: 'redis://localhost:6379',
      channelPrefix: 'myapp:ws:',
    });

    await transport.connect(() => {});

    // Find the sub client (the second one created)
    const subClient = createdInstances[createdInstances.length - 1];
    expect(subClient.subscribedPatterns).toContain('myapp:ws:*');
  });

  test('default channelPrefix is ws:room:', async () => {
    clearInstances();
    const transport = createRedisTransport({ connection: 'redis://localhost:6379' });

    await transport.connect(() => {});

    const subClient = createdInstances[createdInstances.length - 1];
    expect(subClient.subscribedPatterns).toContain('ws:room:*');
  });
});

describe('createRedisTransport — publish', () => {
  test('publish sends JSON-wrapped payload with msg and origin', async () => {
    clearInstances();
    const transport = createRedisTransport({
      connection: 'redis://localhost:6379',
      channelPrefix: 'ws:room:',
    });

    await transport.connect(() => {});

    // pub client is the first instance created, sub is the second
    const pubClient = createdInstances[createdInstances.length - 2];
    await transport.publish('/ws', 'general', JSON.stringify({ text: 'hi' }), 'inst-1');

    expect(pubClient.published).toHaveLength(1);
    const parsed = JSON.parse(pubClient.published[0].payload);
    expect(parsed.msg).toBe(JSON.stringify({ text: 'hi' }));
    expect(parsed.origin).toBe('inst-1');
  });

  test('publish uses wsEndpointKey for the channel', async () => {
    clearInstances();
    const transport = createRedisTransport({
      connection: 'redis://localhost:6379',
      channelPrefix: 'ws:',
    });

    await transport.connect(() => {});

    const pubClient = createdInstances[createdInstances.length - 2];
    await transport.publish('/chat', 'lobby', 'msg', 'inst-x');

    const expectedKey = wsEndpointKey('/chat', 'lobby');
    expect(pubClient.published[0].channel).toBe(`ws:${expectedKey}`);
  });
});

describe('createRedisTransport — pmessage routing', () => {
  test('onMessage callback is invoked when pmessage arrives', async () => {
    clearInstances();
    const received: Array<{ endpoint: string; room: string; message: string; origin: string }> = [];

    const transport = createRedisTransport({
      connection: 'redis://localhost:6379',
      channelPrefix: 'ws:room:',
    });

    await transport.connect((endpoint, room, message, origin) => {
      received.push({ endpoint, room, message, origin });
    });

    const subClient = createdInstances[createdInstances.length - 1];

    // Build the channel key as the transport would
    const compositeKey = wsEndpointKey('/ws', 'general');
    const channel = `ws:room:${compositeKey}`;
    const payload = JSON.stringify({ msg: 'hello from instance-2', origin: 'instance-2' });

    subClient.triggerPmessage('ws:room:*', channel, payload);

    expect(received).toHaveLength(1);
    expect(received[0].endpoint).toBe('/ws');
    expect(received[0].room).toBe('general');
    expect(received[0].message).toBe('hello from instance-2');
    expect(received[0].origin).toBe('instance-2');
  });

  test('malformed JSON payload is silently dropped', async () => {
    clearInstances();
    const received: unknown[] = [];

    const transport = createRedisTransport({
      connection: 'redis://localhost:6379',
      channelPrefix: 'ws:room:',
    });

    await transport.connect((...args) => received.push(args));

    const subClient = createdInstances[createdInstances.length - 1];
    const compositeKey = wsEndpointKey('/ws', 'room');
    const channel = `ws:room:${compositeKey}`;

    // Trigger with invalid JSON
    subClient.triggerPmessage('ws:room:*', channel, '{not valid json!!!');

    expect(received).toHaveLength(0); // Silently dropped
  });

  test('channel without colon separator is silently dropped', async () => {
    clearInstances();
    const received: unknown[] = [];

    const transport = createRedisTransport({
      connection: 'redis://localhost:6379',
      channelPrefix: 'ws:room:',
    });

    await transport.connect((...args) => received.push(args));

    const subClient = createdInstances[createdInstances.length - 1];
    // Channel without colon in the composite key (after stripping prefix)
    const channel = 'ws:room:nocolon'; // compositeKey = "nocolon" — no ':'
    const payload = JSON.stringify({ msg: 'test', origin: 'inst' });

    subClient.triggerPmessage('ws:room:*', channel, payload);

    expect(received).toHaveLength(0); // Silently dropped
  });

  test('percent-encoded endpoint and room are decoded', async () => {
    clearInstances();
    const received: Array<{ endpoint: string; room: string }> = [];

    const transport = createRedisTransport({
      connection: 'redis://localhost:6379',
      channelPrefix: 'ws:room:',
    });

    await transport.connect((endpoint, room) => received.push({ endpoint, room }));

    const subClient = createdInstances[createdInstances.length - 1];
    // Simulate a channel with special characters
    const compositeKey = wsEndpointKey('/chat:special', 'room:1');
    const channel = `ws:room:${compositeKey}`;
    const payload = JSON.stringify({ msg: 'hi', origin: 'inst' });

    subClient.triggerPmessage('ws:room:*', channel, payload);

    expect(received[0].endpoint).toBe('/chat:special');
    expect(received[0].room).toBe('room:1');
  });
});

describe('createRedisTransport — disconnect', () => {
  test('disconnect disconnects both pub and sub clients', async () => {
    clearInstances();
    const transport = createRedisTransport({ connection: 'redis://localhost:6379' });
    await transport.connect(() => {});

    const pubClient = createdInstances[createdInstances.length - 2];
    const subClient = createdInstances[createdInstances.length - 1];

    await transport.disconnect();

    expect(pubClient.disconnected).toBe(true);
    expect(subClient.disconnected).toBe(true);
  });

  test('disconnect sets clients to null (second disconnect is no-op)', async () => {
    clearInstances();
    const transport = createRedisTransport({ connection: 'redis://localhost:6379' });
    await transport.connect(() => {});

    await transport.disconnect();
    // Second disconnect should not throw
    await expect(transport.disconnect()).resolves.toBeUndefined();
  });

  test('publish throws after disconnect', async () => {
    clearInstances();
    const transport = createRedisTransport({ connection: 'redis://localhost:6379' });
    await transport.connect(() => {});
    await transport.disconnect();

    await expect(transport.publish('/ws', 'room', 'msg', 'inst')).rejects.toThrow('Not connected');
  });
});
