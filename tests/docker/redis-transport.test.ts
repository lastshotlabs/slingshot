// Requires Redis. Run with: bun test tests/docker/redis-transport.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRedisTransport } from '../../src/framework/ws/redisTransport';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

describe('RedisTransport (docker)', () => {
  const instanceA = crypto.randomUUID();
  const instanceB = crypto.randomUUID();

  const transportA = createRedisTransport({ connection: REDIS_URL });
  const transportB = createRedisTransport({ connection: REDIS_URL });

  const ENDPOINT = '/ws/test';
  const receivedByA: Array<{ room: string; message: string; origin: string }> = [];
  const receivedByB: Array<{ room: string; message: string; origin: string }> = [];

  beforeAll(async () => {
    await transportA.connect((_endpoint, room, message, origin) => {
      receivedByA.push({ room, message, origin });
    });
    await transportB.connect((_endpoint, room, message, origin) => {
      receivedByB.push({ room, message, origin });
    });
    // Give subscriptions a moment to register
    await new Promise(r => setTimeout(r, 100));
  });

  afterAll(async () => {
    await transportA.disconnect();
    await transportB.disconnect();
  });

  test('message published by A is received by B', async () => {
    const room = 'test-room-1';
    const msg = 'hello from A';

    await transportA.publish(ENDPOINT, room, msg, instanceA);

    // Allow time for delivery
    await new Promise(r => setTimeout(r, 150));

    const match = receivedByB.find(e => e.room === room && e.message === msg);
    expect(match).toBeDefined();
    expect(match!.origin).toBe(instanceA);
  });

  test("message published by A is also received by A's own subscriber (self-echo prevention is caller's responsibility)", async () => {
    // The transport itself forwards all messages including self-published ones.
    // Self-echo filtering (skipping origin === instanceId) is done by ws.ts, not the transport.
    const room = 'test-room-2';
    const msg = 'self echo check';

    const before = receivedByA.length;
    await transportA.publish(ENDPOINT, room, msg, instanceA);

    await new Promise(r => setTimeout(r, 150));

    // A's own subscriber receives the message (origin is intact for the caller to filter)
    const afterMessages = receivedByA.slice(before);
    const match = afterMessages.find(e => e.room === room && e.message === msg);
    expect(match).toBeDefined();
    expect(match!.origin).toBe(instanceA); // origin passed through so ws.ts can self-echo filter
  });

  test('message published by B is received by A with correct room and origin', async () => {
    const room = 'test-room-3';
    const msg = 'hello from B';

    await transportB.publish(ENDPOINT, room, msg, instanceB);

    await new Promise(r => setTimeout(r, 150));

    const match = receivedByA.find(e => e.room === room && e.message === msg);
    expect(match).toBeDefined();
    expect(match!.origin).toBe(instanceB);
  });

  test('different rooms are routed independently', async () => {
    const room1 = 'channel-alpha';
    const room2 = 'channel-beta';

    await transportA.publish(ENDPOINT, room1, 'msg-alpha', instanceA);
    await transportA.publish(ENDPOINT, room2, 'msg-beta', instanceA);

    await new Promise(r => setTimeout(r, 150));

    const alpha = receivedByB.find(e => e.room === room1 && e.message === 'msg-alpha');
    const beta = receivedByB.find(e => e.room === room2 && e.message === 'msg-beta');

    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    // Cross-contamination check
    expect(receivedByB.find(e => e.room === room1 && e.message === 'msg-beta')).toBeUndefined();
    expect(receivedByB.find(e => e.room === room2 && e.message === 'msg-alpha')).toBeUndefined();
  });

  test('disconnect cleans up without throwing', async () => {
    const t = createRedisTransport({ connection: REDIS_URL });
    await t.connect(() => {});
    await expect(t.disconnect()).resolves.toBeUndefined();
  });
});
