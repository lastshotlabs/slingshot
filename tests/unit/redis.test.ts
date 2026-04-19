import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Mock ioredis
// ---------------------------------------------------------------------------

// All created instances, so tests can emit events on them
const redisInstances: MockRedis[] = [];

class MockRedis extends EventEmitter {
  public host: string;
  public port: number;
  public username?: string;
  public password?: string;
  public opts: Record<string, unknown>;

  quit = mock(async () => 'OK');

  constructor(opts: Record<string, unknown>) {
    super();
    this.opts = opts;
    this.host = opts.host as string;
    this.port = opts.port as number;
    this.username = opts.username as string | undefined;
    this.password = opts.password as string | undefined;
    redisInstances.push(this);
    // Auto-emit 'ready' on next tick to simulate successful connection
    setImmediate(() => this.emit('ready'));
  }
}

mock.module('ioredis', () => ({
  default: MockRedis,
}));

const redisLib = await import(`../../src/lib/redis.ts?redis-unit=${Date.now()}`);
const {
  connectRedis,
  disconnectRedis,
  getRedisConnectionOptions,
  getRedisFromApp,
} = redisLib;

describe('getRedisConnectionOptions', () => {
  test('parses host:port format', () => {
    const opts = getRedisConnectionOptions({ host: 'localhost:6379' });
    expect(opts.host).toBe('localhost');
    expect(opts.port).toBe(6379);
  });

  test('throws when host is empty string', () => {
    expect(() => getRedisConnectionOptions({ host: '' })).toThrow('Missing Redis host');
  });

  test('throws when host format is missing port', () => {
    expect(() => getRedisConnectionOptions({ host: 'localhost' })).toThrow('Invalid Redis host format');
  });

  test('includes username when provided', () => {
    const opts = getRedisConnectionOptions({ host: 'localhost:6379', user: 'redisuser' });
    expect(opts.username).toBe('redisuser');
  });

  test('includes password when provided', () => {
    const opts = getRedisConnectionOptions({ host: 'localhost:6379', password: 'secret' });
    expect(opts.password).toBe('secret');
  });

  test('does not include username when not provided', () => {
    const opts = getRedisConnectionOptions({ host: 'localhost:6379' });
    expect(opts.username).toBeUndefined();
  });

  test('does not include password when not provided', () => {
    const opts = getRedisConnectionOptions({ host: 'localhost:6379' });
    expect(opts.password).toBeUndefined();
  });
});

describe('connectRedis', () => {
  test('resolves with Redis client on "ready" event', async () => {
    redisInstances.length = 0; // reset
    const client = await connectRedis({ host: 'localhost:6379' });
    expect(client).toBeInstanceOf(MockRedis);
    expect(redisInstances).toHaveLength(1);
  });

  test('resolved client has correct host and port from credentials', async () => {
    redisInstances.length = 0;
    const client = await connectRedis({ host: 'myhost:6380' }) as unknown as MockRedis;
    expect(client.host).toBe('myhost');
    expect(client.port).toBe(6380);
  });

  test('passes username and password to Redis options', async () => {
    redisInstances.length = 0;
    const client = await connectRedis({
      host: 'myhost:6379',
      user: 'redisuser',
      password: 'supersecret',
    }) as unknown as MockRedis;
    expect(client.username).toBe('redisuser');
    expect(client.password).toBe('supersecret');
  });

  test('registers error handler on client', async () => {
    redisInstances.length = 0;
    const client = await connectRedis({ host: 'localhost:6379' });
    // Ensure error events don't cause unhandled rejection
    // (error listener is registered internally)
    expect((client as unknown as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
  });
});

describe('disconnectRedis', () => {
  test('calls quit() on the client', async () => {
    const client = new MockRedis({ host: 'localhost', port: 6379 });
    await disconnectRedis(client as never);
    expect(client.quit).toHaveBeenCalledTimes(1);
  });

  test('does nothing when client is null', async () => {
    await disconnectRedis(null); // should not throw
  });
});

describe('getRedisFromApp', () => {
  const CTX_SYM = Symbol.for('slingshot.context');

  test('returns redis from SlingshotContext', () => {
    const fakeRedis = { quit: async () => {} };
    const app = { [CTX_SYM]: { redis: fakeRedis } };
    const result = getRedisFromApp(app as never);
    expect(result).toBe(fakeRedis);
  });

  test('returns null when redis is not configured', () => {
    const app = { [CTX_SYM]: { redis: null } };
    const result = getRedisFromApp(app as never);
    expect(result).toBeNull();
  });
});
