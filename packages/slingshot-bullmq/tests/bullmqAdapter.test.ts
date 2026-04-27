import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createFakeBullMQModule, fakeBullMQState } from './helpers/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());

const { createBullMQAdapter, bullmqAdapterOptionsSchema } =
  await import('../src/bullmqAdapter');

afterEach(() => {
  fakeBullMQState.reset();
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('bullmqAdapterOptionsSchema', () => {
  test('accepts minimal config', () => {
    const result = bullmqAdapterOptionsSchema.safeParse({ connection: { host: 'localhost' } });
    expect(result.success).toBe(true);
  });

  test('accepts full config', () => {
    const result = bullmqAdapterOptionsSchema.safeParse({
      connection: { host: 'localhost', port: 6379 },
      prefix: 'myapp:events',
      attempts: 5,
      validation: 'strict',
    });
    expect(result.success).toBe(true);
  });

  test('rejects port as string', () => {
    const result = bullmqAdapterOptionsSchema.safeParse({
      connection: { host: 'localhost', port: '6379' },
    });
    expect(result.success).toBe(false);
  });

  test('rejects unknown validation modes', () => {
    const result = bullmqAdapterOptionsSchema.safeParse({
      connection: {},
      validation: 'unknown',
    });
    expect(result.success).toBe(false);
  });

  test('rejects attempts less than 1', () => {
    const result = bullmqAdapterOptionsSchema.safeParse({
      connection: {},
      attempts: 0,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Non-durable subscriptions (no Redis)
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — non-durable subscriptions', () => {
  test('on() + emit() delivers payload to listener', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    bus.on('auth:login' as any, payload => received.push(payload));
    bus.emit('auth:login' as any, { userId: 'u1' } as any);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ userId: 'u1' });
  });

  test('multiple listeners receive the same event', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const calls: string[] = [];
    bus.on('auth:login' as any, () => calls.push('first'));
    bus.on('auth:login' as any, () => calls.push('second'));
    bus.emit('auth:login' as any, {} as any);
    expect(calls).toEqual(['first', 'second']);
  });

  test('off() removes listener — subsequent emit does not fire it', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const calls: unknown[] = [];
    const listener = () => calls.push(true);
    bus.on('auth:login' as any, listener);
    bus.emit('auth:login' as any, {} as any);
    bus.off('auth:login' as any, listener);
    bus.emit('auth:login' as any, {} as any);
    expect(calls).toHaveLength(1);
  });

  test('off() is a no-op for unregistered listener', () => {
    const bus = createBullMQAdapter({ connection: {} });
    expect(() => bus.off('auth:login' as any, () => {})).not.toThrow();
  });

  test('emit() does not deliver to listeners of other events', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const loginCalls: unknown[] = [];
    const logoutCalls: unknown[] = [];
    bus.on('auth:login' as any, () => loginCalls.push(true));
    bus.on('auth:logout' as any, () => logoutCalls.push(true));
    bus.emit('auth:login' as any, {} as any);
    expect(loginCalls).toHaveLength(1);
    expect(logoutCalls).toHaveLength(0);
  });

  test('listener error is caught and logged, subsequent listeners still fire', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const bus = createBullMQAdapter({ connection: {} });
    const calls: string[] = [];
    bus.on('auth:login' as any, () => {
      throw new Error('boom');
    });
    bus.on('auth:login' as any, () => calls.push('second'));
    bus.emit('auth:login' as any, {} as any);
    await new Promise(r => setTimeout(r, 10));
    expect(calls).toEqual(['second']);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test('emit() does not create Queue or Worker for non-durable events', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, () => {});
    bus.emit('auth:login' as any, {} as any);
    expect(fakeBullMQState.queues).toHaveLength(0);
    expect(fakeBullMQState.workers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Durable subscriptions
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — durable subscriptions', () => {
  test('durable on() creates a Queue and Worker', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });
    expect(fakeBullMQState.queues).toHaveLength(1);
    expect(fakeBullMQState.workers).toHaveLength(1);
  });

  test('queue name sanitizes colons to underscores', () => {
    const bus = createBullMQAdapter({
      connection: {},
      prefix: 'slingshot:events',
    });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'indexer' });
    const qName = fakeBullMQState.queues[0].name;
    expect(qName).not.toContain(':');
    expect(qName).toBe('slingshot_events_auth_login_indexer');
  });

  test('emit() routes payload to durable queue via Queue.add()', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });
    bus.emit('auth:login' as any, { userId: 'u1' } as any);
    await new Promise(r => setTimeout(r, 10));
    const queue = fakeBullMQState.queues[0];
    expect(queue.addCalls).toHaveLength(1);
    expect(queue.addCalls[0].event).toBe('auth:login');
  });

  test('durable on() requires a name', () => {
    const bus = createBullMQAdapter({ connection: {} });
    expect(() =>
      bus.on('auth:login' as any, async () => {}, { durable: true } as any),
    ).toThrow('durable subscriptions require a name');
  });

  test('duplicate durable subscription name for same event throws', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });
    expect(() =>
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' }),
    ).toThrow('already exists');
  });

  test('off() throws for durable subscription', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const listener = async () => {};
    bus.on('auth:login' as any, listener, { durable: true, name: 'audit' });
    expect(() => bus.off('auth:login' as any, listener)).toThrow('cannot remove a durable');
  });

  test('worker processor delivers envelope payload to listener', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    bus.on('auth:login' as any, async payload => received.push(payload), {
      durable: true,
      name: 'audit',
    });

    const queueName = fakeBullMQState.queues[0].name;
    // Simulate a job arriving — data must be a valid EventEnvelope
    await fakeBullMQState.dispatchJob(queueName, 'auth:login', {
      key: 'auth:login',
      payload: { userId: 'u2' },
      meta: {
        eventId: 'evt-1',
        occurredAt: new Date().toISOString(),
        ownerPlugin: 'test',
        exposure: ['internal'],
        scope: null,
        requestTenantId: null,
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ userId: 'u2' });
  });
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — shutdown', () => {
  test('shutdown closes all workers and queues', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'w1' });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'w2' });

    await bus.shutdown();

    expect(fakeBullMQState.workers.every(w => w.closed)).toBe(true);
    expect(fakeBullMQState.queues.every(q => q.closed)).toBe(true);
  });

  test('shutdown logs warning when pending buffer has items', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });

    // Inject a Queue.add() failure so the event lands in pending buffer
    fakeBullMQState.nextAddError(new Error('Redis down'));

    bus.emit('auth:login' as any, {} as any);
    await new Promise(r => setTimeout(r, 10));

    await bus.shutdown();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('discarding'),
    );

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('shutdown clears listener maps so subsequent emits are no-ops', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    const calls: unknown[] = [];
    bus.on('auth:login' as any, () => calls.push(true));

    await bus.shutdown();
    bus.emit('auth:login' as any, {} as any);

    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pending buffer drain
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — _drainPendingBuffer', () => {
  test('retries buffered events after Redis recovers', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });

    // Cause the first Queue.add() to fail so the event is buffered
    fakeBullMQState.nextAddError(new Error('Redis down'));
    bus.emit('auth:login' as any, { userId: 'retry' } as any);
    await new Promise(r => setTimeout(r, 10));

    const queueBefore = fakeBullMQState.queues[0].addCalls.length;
    // No successful adds yet
    expect(queueBefore).toBe(0);

    // Drain — Redis is now healthy
    await bus._drainPendingBuffer();

    expect(fakeBullMQState.queues[0].addCalls).toHaveLength(1);

    errorSpy.mockRestore();
  });

  test('drain is a no-op when buffer is empty', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });

    // Should not throw or create calls
    await bus._drainPendingBuffer();
    expect(fakeBullMQState.queues[0].addCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Options validation at creation time
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — invalid options', () => {
  test('throws when connection.port is a string', () => {
    expect(() =>
      createBullMQAdapter({ connection: { host: 'localhost', port: '6379' as any } }),
    ).toThrow();
  });
});
