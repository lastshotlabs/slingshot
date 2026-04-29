/**
 * Queue-management tests for createBullMQAdapter.
 *
 * Covers queue lifecycle: creation, naming, sanitization, prefix handling,
 * and closure through the adapter lifecycle.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createFakeBullMQModule, fakeBullMQState } from '../src/testing/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());

const { createBullMQAdapter } = await import('../src/bullmqAdapter');

afterEach(() => {
  fakeBullMQState.reset();
});

// ---------------------------------------------------------------------------
// Queue creation
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — queue creation', () => {
  test('no queues exist before any durable subscription', () => {
    const bus = createBullMQAdapter({ connection: {} });
    expect(fakeBullMQState.queues).toHaveLength(0);
    expect(bus.getHealthDetails().queueCount).toBe(0);
  });

  test('durable subscription creates exactly one queue', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });
    expect(fakeBullMQState.queues).toHaveLength(1);
    expect(bus.getHealthDetails().queueCount).toBe(1);
  });

  test('two distinct durable subscriptions create two queues', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });
    bus.on('auth:logout' as any, async () => {}, { durable: true, name: 'logger' });
    expect(fakeBullMQState.queues).toHaveLength(2);
    expect(bus.getHealthDetails().queueCount).toBe(2);
  });

  test('same event with different subscription names creates separate queues', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'indexer' });
    expect(fakeBullMQState.queues).toHaveLength(2);
  });

  test('queue name excludes colons (replaced with underscores)', () => {
    const bus = createBullMQAdapter({ connection: {}, prefix: 'myapp:events' });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'my-worker' });
    const qName = fakeBullMQState.queues[0].name;
    expect(qName).not.toContain(':');
    expect(qName).toBe('myapp_events_auth_login_my-worker');
  });
});

// ---------------------------------------------------------------------------
// Queue naming with special characters
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — queue naming with special characters', () => {
  test('event name with dots is preserved while colons are sanitized', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('user.created' as any, async () => {}, { durable: true, name: 'audit' });
    const qName = fakeBullMQState.queues[0].name;
    expect(qName).toBe('slingshot_events_user.created_audit');
  });

  test('event name with hyphens is preserved', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('user-created' as any, async () => {}, { durable: true, name: 'audit' });
    const qName = fakeBullMQState.queues[0].name;
    expect(qName).toContain('user-created');
  });

  test('prefix with trailing colon is sanitized', () => {
    const bus = createBullMQAdapter({ connection: {}, prefix: 'slingshot:' });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });
    const qName = fakeBullMQState.queues[0].name;
    expect(qName).not.toContain(':');
  });

  test('prefix with underscores is preserved as-is', () => {
    const bus = createBullMQAdapter({ connection: {}, prefix: 'my_app_events' });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'worker' });
    const qName = fakeBullMQState.queues[0].name;
    expect(qName).toContain('my_app_events');
  });

  test('subscription name with spaces is preserved', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'my worker' });
    const qName = fakeBullMQState.queues[0].name;
    expect(qName).toContain('my worker');
  });
});

// ---------------------------------------------------------------------------
// Queue closure
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — queue closure', () => {
  test('shutdown closes all queues', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'q1' });
    bus.on('auth:logout' as any, async () => {}, { durable: true, name: 'q2' });
    await bus.shutdown();
    expect(fakeBullMQState.queues.every(q => q.closed)).toBe(true);
  });

  test('queue close is idempotent — calling shutdown twice does not throw', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'q1' });
    await bus.shutdown();
    await expect(bus.shutdown()).resolves.toBeUndefined();
  });

  test('queue is not closed before shutdown', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'q1' });
    expect(fakeBullMQState.queues.every(q => q.closed)).toBe(false);
  });
});
