/**
 * Tests for requireIoredis direct constructor path in redisTransport.ts (line 36).
 *
 * Separate file because mock.module is permanent per-file.
 * When mock.module returns { default: fn, __esModule: true }, createRequire
 * returns the function directly. hasDefaultRedisConstructor fails (no .default
 * on a function), so isRedisConstructor is checked next (line 36).
 */
import { describe, expect, mock, test } from 'bun:test';
import { createRedisTransport } from '../../src/framework/ws/redisTransport';

function createMockRedisInstance() {
  return {
    published: [] as Array<{ channel: string; payload: string }>,
    subscribedPatterns: [] as string[],
    disconnected: false,
    pmessageHandlers: [] as Array<(...args: unknown[]) => unknown>,
    publish(channel: string, payload: string) {
      this.published.push({ channel, payload });
      return Promise.resolve(1);
    },
    psubscribe(pattern: string) {
      this.subscribedPatterns.push(pattern);
      return Promise.resolve();
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (event === 'pmessage') this.pmessageHandlers.push(handler);
      return this;
    },
    disconnect() {
      this.disconnected = true;
    },
  };
}

mock.module('ioredis', () => {
  function MockRedis() {
    return createMockRedisInstance();
  }
  MockRedis.prototype = {};
  return { default: MockRedis, __esModule: true };
});

describe('requireIoredis — direct constructor path (line 36)', () => {
  test('connect succeeds when require returns a direct constructor function', async () => {
    const transport = createRedisTransport({ connection: 'redis://localhost:6379' });
    // Should not throw — requireIoredis hits isRedisConstructor(mod) on line 36
    await transport.connect(() => {});
    // Verify it's functional
    await expect(transport.publish('/ws', 'room', 'msg', 'origin')).resolves.toBeUndefined();
  });
});
