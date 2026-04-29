/**
 * Durable subscription registration and lifecycle tests for createBullMQAdapter.
 *
 * Covers aspects beyond the basic create/emit/off pattern tested in the main
 * bullmqAdapter.test.ts:
 *  - same name for different events is valid
 *  - multiple durable subscriptions across events
 *  - custom prefix integration
 *  - name with dots and other special characters
 *  - onEnvelope with durable option
 *  - same event with multiple distinct durable names
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createFakeBullMQModule, fakeBullMQState } from '../src/testing/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());

const { createBullMQAdapter } = await import('../src/bullmqAdapter');

afterEach(() => {
  fakeBullMQState.reset();
});

describe('createBullMQAdapter — durable subscriptions', () => {
  // -----------------------------------------------------------------------
  // Name uniqueness rules
  // -----------------------------------------------------------------------

  test('same subscription name for different events does not throw', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });
    expect(() =>
      bus.on('auth:logout' as any, async () => {}, { durable: true, name: 'audit' }),
    ).not.toThrow();
  });

  test('duplicate name for same event throws DuplicateDurableSubscriptionError', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });
    expect(() =>
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' }),
    ).toThrow('already exists');
  });

  test('same event with two different durable names is valid', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });
    expect(() =>
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'indexer' }),
    ).not.toThrow();
    expect(fakeBullMQState.queues).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // Queue / worker creation
  // -----------------------------------------------------------------------

  test('each durable subscription creates a separate queue and worker', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'indexer' });
    bus.on('auth:logout' as any, async () => {}, { durable: true, name: 'notifier' });
    expect(fakeBullMQState.queues).toHaveLength(2);
    expect(fakeBullMQState.workers).toHaveLength(2);
  });

  test('durable subscription with custom prefix reflects prefix in queue name', () => {
    const bus = createBullMQAdapter({ connection: {}, prefix: 'custom.app' });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'worker1' });
    const qName = fakeBullMQState.queues[0].name;
    expect(qName).toContain('custom.app');
    expect(qName).not.toContain(':'); // colons sanitized to underscores
  });

  test('durable subscription name with dots is preserved in the queue name', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('user:created' as any, async () => {}, { durable: true, name: 'my.worker.v1' });
    const qName = fakeBullMQState.queues[0].name;
    expect(qName).toContain('my.worker.v1');
  });

  test('default prefix slingshot:events appears in queue name', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('entity:post:created' as any, async () => {}, { durable: true, name: 'search-indexer' });
    // Prefix "slingshot:events" → colons replaced with underscores → "slingshot_events"
    const qName = fakeBullMQState.queues[0].name;
    expect(qName).toContain('slingshot_events');
  });

  // -----------------------------------------------------------------------
  // Event routing
  // -----------------------------------------------------------------------

  test('emit routes only to the matching durable queue', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'login-worker' });
    bus.on('user:signup' as any, async () => {}, { durable: true, name: 'signup-worker' });

    bus.emit('auth:login' as any, { userId: 'u1' } as any);
    await new Promise(r => setTimeout(r, 20));

    const loginQueue = fakeBullMQState.queues.find(q => q.name.includes('auth_login'));
    const signupQueue = fakeBullMQState.queues.find(q => q.name.includes('user_signup'));
    expect(loginQueue?.addCalls).toHaveLength(1);
    expect(signupQueue?.addCalls).toHaveLength(0);
  });

  test('emit with no matching durable subscription does not create queue.add calls', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'only-login' });
    bus.emit('user:signup' as any, {} as any);
    // No durable queue for user:signup, so no add calls
    const loginQueue = fakeBullMQState.queues[0];
    expect(loginQueue?.addCalls ?? []).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // onEnvelope with durable
  // -----------------------------------------------------------------------

  test('onEnvelope with durable option creates a queue and worker', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.onEnvelope('auth:login' as any, async () => {}, { durable: true, name: 'env-worker' });
    expect(fakeBullMQState.queues).toHaveLength(1);
    expect(fakeBullMQState.workers).toHaveLength(1);
  });

  test('onEnvelope durable requires a name', () => {
    const bus = createBullMQAdapter({ connection: {} });
    expect(() =>
      bus.onEnvelope('auth:login' as any, async () => {}, { durable: true } as any),
    ).toThrow('durable subscriptions require a name');
  });

  // -----------------------------------------------------------------------
  // off() guards
  // -----------------------------------------------------------------------

  test('off() throws for a durable subscription registered via onEnvelope', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const listener = async () => {};
    bus.onEnvelope('auth:login' as any, listener, { durable: true, name: 'off-guard' });
    expect(() => bus.offEnvelope('auth:login' as any, listener)).toThrow(
      'cannot remove a durable subscription',
    );
  });

  test('off() is a no-op for an unregistered listener (non-durable)', () => {
    const bus = createBullMQAdapter({ connection: {} });
    expect(() => bus.off('auth:login' as any, () => {})).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Durable offByOne / offEnvelope path
  // -----------------------------------------------------------------------

  test('offEnvelope without durable does not throw', () => {
    const bus = createBullMQAdapter({ connection: {} });
    expect(() => bus.offEnvelope('auth:login' as any, () => {})).not.toThrow();
  });
});
