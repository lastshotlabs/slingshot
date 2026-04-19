import { afterAll, describe, expect, it } from 'bun:test';
import {
  connectTestMongo,
  connectTestRedis,
  disconnectTestServices,
  getTestAppConn,
  getTestAuthConn,
  getTestRedis,
} from '../setup-docker';

describe('Redis connection', () => {
  afterAll(async () => {
    await disconnectTestServices();
  });

  it('connects and returns a working client', async () => {
    await connectTestRedis();
    const redis = getTestRedis();
    expect(redis).toBeTruthy();

    // Verify it's alive
    const pong = await redis.ping();
    expect(pong).toBe('PONG');
  });

  it('can set and get a value', async () => {
    const redis = getTestRedis();
    await redis.set('test-conn-key', 'hello');
    const val = await redis.get('test-conn-key');
    expect(val).toBe('hello');
    await redis.del('test-conn-key');
  });
});

describe('MongoDB connection', () => {
  afterAll(async () => {
    await disconnectTestServices();
  });

  it('connects auth and app connections', async () => {
    await connectTestMongo();
    const authConn = getTestAuthConn();
    const appConn = getTestAppConn();
    expect(authConn.readyState).toBe(1); // connected
    expect(appConn.readyState).toBe(1);
  });

  it('can perform basic operations', async () => {
    const authConn = getTestAuthConn();
    const db = authConn.db!;

    await db.collection('connection_test').insertOne({ test: true });
    const doc = await db.collection('connection_test').findOne({ test: true });
    expect(doc).not.toBeNull();
    expect(doc!.test).toBe(true);

    await db.collection('connection_test').drop();
  });
});

describe('getRedisConnectionOptions', () => {
  it('parses host:port from env var', async () => {
    const { getRedisConnectionOptions } = await import('../../src/lib/redis');
    const opts = getRedisConnectionOptions({ host: process.env.REDIS_HOST ?? 'localhost:6380' });
    expect(opts.host).toBe('localhost');
    expect(opts.port).toBe(6380);
  });
});
