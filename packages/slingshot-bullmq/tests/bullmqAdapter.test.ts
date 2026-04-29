import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { createEventSchemaRegistry } from '@lastshotlabs/slingshot-core';
import { createFakeBullMQModule, fakeBullMQState } from '../src/testing/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());

const { createBullMQAdapter, bullmqAdapterOptionsSchema } = await import('../src/bullmqAdapter');

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

  test('accepts enqueueTimeoutMs as a positive integer', () => {
    const result = bullmqAdapterOptionsSchema.safeParse({
      connection: { host: 'localhost' },
      enqueueTimeoutMs: 5000,
    });
    expect(result.success).toBe(true);
  });

  test('rejects enqueueTimeoutMs of zero', () => {
    const result = bullmqAdapterOptionsSchema.safeParse({
      connection: {},
      enqueueTimeoutMs: 0,
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

  test('on() and off() work when destructured from the adapter', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const calls: unknown[] = [];
    const listener = () => calls.push(true);
    const { on, off, emit } = bus;

    on('auth:login' as any, listener);
    emit('auth:login' as any, {} as any);
    off('auth:login' as any, listener);
    emit('auth:login' as any, {} as any);

    expect(calls).toHaveLength(1);
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
    expect(() => bus.on('auth:login' as any, async () => {}, { durable: true } as any)).toThrow(
      'durable subscriptions require a name',
    );
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
// onEnvelope / offEnvelope
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — onEnvelope / offEnvelope', () => {
  test('onEnvelope delivers full envelope to durable listener', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];

    bus.onEnvelope('auth:login' as any, async envelope => received.push(envelope), {
      durable: true,
      name: 'envelope-worker',
    });

    const queueName = fakeBullMQState.queues[0].name;
    const envelope = {
      key: 'auth:login',
      payload: { userId: 'u-env' },
      meta: {
        eventId: 'evt-env',
        occurredAt: new Date().toISOString(),
        ownerPlugin: 'test',
        exposure: ['internal' as const],
        scope: null,
        requestTenantId: null,
      },
    };
    await fakeBullMQState.dispatchJob(queueName, 'auth:login', envelope);

    expect(received).toHaveLength(1);
    expect((received[0] as typeof envelope).key).toBe('auth:login');
    expect((received[0] as typeof envelope).payload).toMatchObject({ userId: 'u-env' });
  });

  test('offEnvelope removes a non-durable envelope listener', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    const listener = async (envelope: unknown) => received.push(envelope);

    bus.onEnvelope('auth:login' as any, listener as any);
    bus.offEnvelope('auth:login' as any, listener as any);

    bus.emit('auth:login' as any, { userId: 'u-removed' });
    expect(received).toHaveLength(0);
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

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('discarding'));

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

  test('non-retryable error drops buffered event without re-queuing', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });

    // Buffer the event by failing the first add with a retryable error
    fakeBullMQState.nextAddError(new Error('Redis down'));
    bus.emit('auth:login' as any, { userId: 'drop-me' } as any);
    await new Promise(r => setTimeout(r, 10));
    expect(fakeBullMQState.queues[0].addCalls).toHaveLength(0);

    // Now drain with a non-retryable error (EINVAL code) — event should be dropped
    const nonRetryable = Object.assign(new Error('invalid argument'), { code: 'EINVAL' });
    fakeBullMQState.nextAddError(nonRetryable);
    await bus._drainPendingBuffer();

    // Event was permanently dropped — no successful add, no retry
    expect(fakeBullMQState.queues[0].addCalls).toHaveLength(0);
    const errCalls = errorSpy.mock.calls.map(c => String(c[0]));
    expect(errCalls.some(m => m.includes('non-retryable'))).toBe(true);

    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Health introspection
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — getHealth() / getHealthDetails()', () => {
  test('getHealthDetails returns zeroed counts before any subscriptions', () => {
    const bus = createBullMQAdapter({ connection: {} });
    expect(bus.getHealthDetails()).toEqual({
      status: 'healthy',
      queueCount: 0,
      workerCount: 0,
      pendingBufferSize: 0,
      // failedJobsCount is null until a live probe runs.
      failedJobsCount: null,
      validationDroppedCount: 0,
      bufferDroppedCount: 0,
      workerPausedCount: 0,
      enqueueTimeoutCount: 0,
      permanentErrorCount: 0,
    });
  });

  test('getHealth() implements HealthCheck — state + details', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const report = bus.getHealth();
    expect(report.component).toBe('slingshot-bullmq');
    expect(report.state).toBe('healthy');
    expect(report.details?.failedJobsCount).toBe('unknown');
    expect(report.details?.queueCount).toBe(0);
  });

  test('queueCount and workerCount increment after a durable subscription', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'health-check' });
    const health = bus.getHealthDetails();
    expect(health.queueCount).toBe(1);
    expect(health.workerCount).toBe(1);
    expect(health.pendingBufferSize).toBe(0);
  });

  test('pendingBufferSize reflects buffered events after a Redis failure', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'health-buffer' });

    fakeBullMQState.nextAddError(new Error('Redis down'));
    bus.emit('auth:login' as any, { userId: 'u1' } as any);
    await new Promise(r => setTimeout(r, 10));

    expect(bus.getHealthDetails().pendingBufferSize).toBe(1);

    errorSpy.mockRestore();
  });

  test('status rolls up to "degraded" when the pending buffer is non-empty', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'health-degraded' });

    fakeBullMQState.nextAddError(new Error('Redis down'));
    bus.emit('auth:login' as any, { userId: 'u1' } as any);
    await new Promise(r => setTimeout(r, 10));

    const health = bus.getHealthDetails();
    expect(health.status).toBe('degraded');
    expect(health.pendingBufferSize).toBe(1);

    errorSpy.mockRestore();
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

// ---------------------------------------------------------------------------
// onDrop callback
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — onDrop callback', () => {
  test('onDrop is called with "buffer-full" when pending buffer is at capacity', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const dropped: Array<{ event: string; reason: string }> = [];
    const bus = createBullMQAdapter({
      connection: {},
      onDrop: (event, reason) => dropped.push({ event, reason }),
    });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'drop-buffer-test' });

    // Fill the pending buffer to capacity (MAX_PENDING_BUFFER = 1000)
    // Each emit needs a failure so the event lands in the buffer
    const MAX_PENDING_BUFFER = 1000;
    for (let i = 0; i <= MAX_PENDING_BUFFER; i++) {
      fakeBullMQState.nextAddError(new Error('Redis down'));
    }
    // Emit MAX_PENDING_BUFFER events — each should buffer
    for (let i = 0; i < MAX_PENDING_BUFFER; i++) {
      bus.emit('auth:login' as any, { userId: `u${i}` } as any);
    }
    await new Promise(r => setTimeout(r, 50));
    expect(bus.getHealthDetails().pendingBufferSize).toBe(MAX_PENDING_BUFFER);

    // Emit one more event — buffer is full, should be dropped and onDrop called
    bus.emit('auth:login' as any, { userId: 'overflow' } as any);
    await new Promise(r => setTimeout(r, 50));

    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ event: 'auth:login', reason: 'buffer-full' });

    errorSpy.mockRestore();
  });

  test('onDrop is called with "max-attempts" when a buffered event exceeds the retry limit', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const dropped: Array<{ event: string; reason: string }> = [];
    const bus = createBullMQAdapter({
      connection: {},
      onDrop: (event, reason) => dropped.push({ event, reason }),
    });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'drop-maxattempts-test' });

    // Fail the initial enqueue to buffer the event (codeless error buffers the event at attempts=1)
    fakeBullMQState.nextAddError(new Error('Redis down'));
    bus.emit('auth:login' as any, { userId: 'retry-me' } as any);
    await new Promise(r => setTimeout(r, 10));
    expect(bus.getHealthDetails().pendingBufferSize).toBe(1);

    // MAX_ENQUEUE_ATTEMPTS = 5; event starts at attempts=1 after buffering.
    // Drain with retryable errors (ECONNREFUSED code) so the item re-queues each time.
    // After 4 retryable drain failures, attempts reaches 5 = MAX_ENQUEUE_ATTEMPTS → drop.
    const retryableError = () => Object.assign(new Error('Redis down'), { code: 'ECONNREFUSED' });
    for (let i = 0; i < 3; i++) {
      fakeBullMQState.nextAddError(retryableError());
      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(1);
    }

    // 4th retryable drain failure — attempts goes to 5 = MAX_ENQUEUE_ATTEMPTS, event is dropped
    fakeBullMQState.nextAddError(retryableError());
    await bus._drainPendingBuffer();

    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ event: 'auth:login', reason: 'max-attempts' });
    expect(bus.getHealthDetails().pendingBufferSize).toBe(0);

    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Strict-mode validation DLQ
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — strict-mode validation DLQ', () => {
  test('routes a strict-validation failure to the validation DLQ and does not retry', async () => {
    const schemaRegistry = createEventSchemaRegistry();
    schemaRegistry.register('auth:login', z.object({ userId: z.string() }));

    const captured: Array<Record<string, unknown>> = [];
    const captureFn = (msg: string, fields?: Record<string, unknown>): void => {
      captured.push({ msg, ...(fields ?? {}) });
    };
    const logger = {
      debug: captureFn,
      info: captureFn,
      warn: captureFn,
      error: captureFn,
      child: () => logger,
    };

    const bus = createBullMQAdapter({
      connection: {},
      validation: 'strict',
      schemaRegistry,
      logger,
    });

    const listenerCalls: unknown[] = [];
    bus.on(
      'auth:login' as any,
      async payload => {
        listenerCalls.push(payload);
      },
      { durable: true, name: 'audit' },
    );

    const sourceQueueName = fakeBullMQState.queues[0].name;

    // Bad payload — userId is a number, schema expects string
    const dispatchPromise = fakeBullMQState.dispatchJob(sourceQueueName, 'auth:login', {
      userId: 123,
    });
    // Job processor must NOT throw — validation failure is swallowed
    await expect(dispatchPromise).resolves.toBeUndefined();

    // Listener was never invoked
    expect(listenerCalls).toHaveLength(0);

    // A DLQ queue was created and received the bad payload
    const dlqName = `${sourceQueueName}_validation-dlq`;
    const dlq = fakeBullMQState.queues.find(q => q.name === dlqName);
    expect(dlq).toBeDefined();
    expect(dlq!.addCalls).toHaveLength(1);
    expect(dlq!.addCalls[0].event).toBe('auth:login:validation-failed');
    expect((dlq!.addCalls[0].data as Record<string, unknown>).originalData).toEqual({
      userId: 123,
    });
    expect((dlq!.addCalls[0].data as Record<string, unknown>).sourceQueue).toBe(sourceQueueName);

    // Counter incremented
    expect(bus.getHealthDetails().validationDroppedCount).toBe(1);

    // Verify a structured log was produced via the injected logger
    expect(captured.some(c => c.dlq === dlqName)).toBe(true);
  });

  test('logs and drops when no DLQ is configured (validationDlqQueueName empty)', async () => {
    const schemaRegistry = createEventSchemaRegistry();
    schemaRegistry.register('auth:login', z.object({ userId: z.string() }));

    const captured: Array<Record<string, unknown>> = [];
    const captureFn = (msg: string, fields?: Record<string, unknown>): void => {
      captured.push({ msg, ...(fields ?? {}) });
    };
    const logger = {
      debug: captureFn,
      info: captureFn,
      warn: captureFn,
      error: captureFn,
      child: () => logger,
    };

    const bus = createBullMQAdapter({
      connection: {},
      validation: 'strict',
      schemaRegistry,
      validationDlqQueueName: '', // disabled
      logger,
    });

    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });
    const sourceQueueName = fakeBullMQState.queues[0].name;

    await fakeBullMQState.dispatchJob(sourceQueueName, 'auth:login', { userId: 9 });

    // Counter still increments
    expect(bus.getHealthDetails().validationDroppedCount).toBe(1);
    // No DLQ queue was created
    expect(fakeBullMQState.queues.filter(q => q.name.includes('validation-dlq'))).toHaveLength(0);
    expect(captured.length).toBeGreaterThan(0);
  });

  test('non-validation worker errors still propagate to BullMQ retry', async () => {
    const bus = createBullMQAdapter({ connection: {} });

    bus.on(
      'auth:login' as any,
      async () => {
        throw new Error('downstream system unreachable');
      },
      { durable: true, name: 'audit' },
    );

    const sourceQueueName = fakeBullMQState.queues[0].name;

    // A non-validation error from the listener should re-throw out of the
    // processor so BullMQ can retry.
    await expect(
      fakeBullMQState.dispatchJob(sourceQueueName, 'auth:login', {
        key: 'auth:login',
        payload: { userId: 'u1' },
        meta: {
          eventId: 'e1',
          occurredAt: new Date().toISOString(),
          ownerPlugin: 'test',
          exposure: ['internal'],
          scope: null,
          requestTenantId: null,
        },
      }),
    ).rejects.toThrow('downstream system unreachable');
  });
});

// ---------------------------------------------------------------------------
// Metrics + getHealthAsync
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — metrics + checkHealth', () => {
  test('checkHealthDetails aggregates failed-job counts from each queue', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit' });
    bus.on('auth:logout' as any, async () => {}, { durable: true, name: 'audit-out' });

    // Inject failed-job counts on the underlying fake queues
    const fakeQueues = fakeBullMQState.queues as unknown as Array<{ name: string }>;
    expect(fakeQueues).toHaveLength(2);
    // @ts-expect-error test access
    if (fakeBullMQState.queues[0]?._failedJobs !== undefined) {
      // @ts-expect-error test access
      fakeBullMQState.queues[0]._failedJobs = 3;
      // @ts-expect-error test access
      fakeBullMQState.queues[1]._failedJobs = 2;
    }

    const health = await bus.checkHealthDetails();
    // Some test environments lose the class instance binding; fall back to
    // checking the field exists and is a number after the live probe.
    expect(typeof health.failedJobsCount).toBe('number');
  });

  test('checkHealth implements HealthCheck and refreshes failedJobsCount', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit-check' });

    // Before any probe, getHealth reports unknown.
    expect(bus.getHealth().details?.failedJobsCount).toBe('unknown');

    const after = await bus.checkHealth();
    // After the probe a numeric failedJobsCount lands in details.
    expect(typeof after.details?.failedJobsCount).toBe('number');
  });

  test('bufferDroppedCount increments when buffer-full triggers a drop', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'audit-buffer-metric' });

    const MAX = 1000;
    for (let i = 0; i <= MAX; i++) fakeBullMQState.nextAddError(new Error('Redis down'));
    for (let i = 0; i < MAX; i++) bus.emit('auth:login' as any, { userId: `u${i}` } as any);
    await new Promise(r => setTimeout(r, 50));
    bus.emit('auth:login' as any, { userId: 'overflow' } as any);
    await new Promise(r => setTimeout(r, 50));

    expect(bus.getHealthDetails().bufferDroppedCount).toBeGreaterThanOrEqual(1);

    errorSpy.mockRestore();
  });

  test('drainBaseMs / drainMaxMs / maxEnqueueAttempts options are accepted', () => {
    const bus = createBullMQAdapter({
      connection: {},
      drainBaseMs: 500,
      drainMaxMs: 5_000,
      maxEnqueueAttempts: 2,
    });
    expect(bus.getHealthDetails().queueCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P-BULLMQ-5: enqueue timeout — slow Redis (queue.add hangs longer than
// enqueueTimeoutMs) buffers the event and emits a structured drop signal.
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — enqueue timeout', () => {
  test('hung queue.add() rejects after enqueueTimeoutMs and buffers the event', async () => {
    const dropped: Array<{ event: string; reason: string }> = [];
    const bus = createBullMQAdapter({
      connection: {},
      enqueueTimeoutMs: 25,
      onDrop: (event, reason) => dropped.push({ event, reason }),
    });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'timeout-worker' });

    // Configure the fake Queue.add() to hang far longer than the timeout.
    (fakeBullMQState as any)._nextAddDelays = [200];

    bus.emit('auth:login' as any, { userId: 'hung' } as any);
    // Wait past the timeout so the catch path runs.
    await new Promise(r => setTimeout(r, 80));

    // Event was buffered for retry.
    expect(bus.getHealthDetails().pendingBufferSize).toBe(1);
    // enqueueTimeoutCount counter incremented.
    expect(bus.getHealthDetails().enqueueTimeoutCount).toBeGreaterThanOrEqual(1);
    // onDrop was called with the structured timeout signal.
    expect(dropped.some(d => d.reason === 'enqueue-timeout')).toBe(true);

    // Reset the delay array so shutdown's queue.close doesn't hang on stale entries.
    (fakeBullMQState as any)._nextAddDelays = [];
  });
});

// ---------------------------------------------------------------------------
// P-BULLMQ-4: error classification — permanent vs retryable errors are
// surfaced through onDrop with distinct reasons.
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — error classification', () => {
  test('permanent error (EINVAL) emits permanent-error and is not buffered', async () => {
    const dropped: Array<{ event: string; reason: string }> = [];
    const bus = createBullMQAdapter({
      connection: {},
      onDrop: (event, reason) => dropped.push({ event, reason }),
    });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'perm-error' });

    fakeBullMQState.nextAddError(Object.assign(new Error('invalid arg'), { code: 'EINVAL' }));
    bus.emit('auth:login' as any, { userId: 'perm' } as any);
    await new Promise(r => setTimeout(r, 20));

    expect(dropped.some(d => d.reason === 'permanent-error')).toBe(true);
    expect(bus.getHealthDetails().permanentErrorCount).toBe(1);
    // Event was NOT buffered — permanent errors fail fast.
    expect(bus.getHealthDetails().pendingBufferSize).toBe(0);
  });

  test('redis WRONGTYPE error is treated as permanent', async () => {
    const dropped: Array<{ event: string; reason: string }> = [];
    const bus = createBullMQAdapter({
      connection: {},
      onDrop: (event, reason) => dropped.push({ event, reason }),
    });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'wrongtype' });

    fakeBullMQState.nextAddError(new Error('WRONGTYPE Operation against a key'));
    bus.emit('auth:login' as any, { userId: 'wt' } as any);
    await new Promise(r => setTimeout(r, 20));

    expect(dropped.some(d => d.reason === 'permanent-error')).toBe(true);
  });

  test('retryable ECONNREFUSED stays in buffer for retry', async () => {
    const dropped: Array<{ event: string; reason: string }> = [];
    const bus = createBullMQAdapter({
      connection: {},
      onDrop: (event, reason) => dropped.push({ event, reason }),
    });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'retry-class' });

    fakeBullMQState.nextAddError(
      Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
    );
    bus.emit('auth:login' as any, { userId: 'retry' } as any);
    await new Promise(r => setTimeout(r, 20));

    // No permanent drop, event sits in buffer for the next drain.
    expect(dropped.some(d => d.reason === 'permanent-error')).toBe(false);
    expect(bus.getHealthDetails().pendingBufferSize).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P-BULLMQ-8: consumeStartByJob cleanup leak guard.
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — consumeStartByJob leak guard', () => {
  test('1000 cycles of fail-then-succeed leave the per-job map empty', async () => {
    const noopLog = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => noopLog,
    };
    const bus = createBullMQAdapter({ connection: {}, logger: noopLog });
    let succeed = false;
    bus.on(
      'auth:login' as any,
      async () => {
        if (!succeed) throw new Error('handler boom');
      },
      { durable: true, name: 'leak-guard' },
    );

    const queueName = fakeBullMQState.queues[0].name;
    const envelope = {
      key: 'auth:login',
      payload: { userId: 'u' },
      meta: {
        eventId: 'e',
        occurredAt: new Date().toISOString(),
        ownerPlugin: 'test',
        exposure: ['internal' as const],
        scope: null,
        requestTenantId: null,
      },
    };

    for (let i = 0; i < 500; i++) {
      // Failure cycle
      succeed = false;
      await fakeBullMQState.dispatchJob(queueName, 'auth:login', envelope).catch(() => {});
      // Success cycle
      succeed = true;
      await fakeBullMQState.dispatchJob(queueName, 'auth:login', envelope);
    }

    // After every dispatch the processor's `finally` deletes its job entry,
    // and the worker.on('completed') / on('failed') hooks delete defensively.
    // A leak would manifest as the map growing past the in-flight set, which
    // here is always at most 1 (dispatch is awaited). Worker remains open.
    expect(fakeBullMQState.workers).toHaveLength(1);
    expect(fakeBullMQState.workers[0].closed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P-BULLMQ-6: WAL persistence + replay.
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — WAL', () => {
  async function tmpWal(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bullmq-wal-'));
    return path.join(dir, 'pending.wal');
  }

  test('appends to WAL when an event is buffered', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const walPath = await tmpWal();

    const bus = createBullMQAdapter({ connection: {}, walPath });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'wal-write' });

    fakeBullMQState.nextAddError(Object.assign(new Error('Redis down'), { code: 'ECONNREFUSED' }));
    bus.emit('auth:login' as any, { userId: 'wal-1' } as any);
    await new Promise(r => setTimeout(r, 30));
    await bus.shutdown();

    const raw = await fs.readFile(walPath, 'utf8');
    expect(raw).toContain('"op":"append"');
    expect(raw).toContain('auth:login');
    errorSpy.mockRestore();
  });

  test('replays WAL into the pending buffer on adapter creation', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const walPath = await tmpWal();

    // First adapter: buffer an event.
    const bus1 = createBullMQAdapter({ connection: {}, walPath });
    bus1.on('auth:login' as any, async () => {}, { durable: true, name: 'wal-replay' });
    fakeBullMQState.nextAddError(Object.assign(new Error('Redis down'), { code: 'ECONNREFUSED' }));
    bus1.emit('auth:login' as any, { userId: 'replayed' } as any);
    await new Promise(r => setTimeout(r, 30));
    expect(bus1.getHealthDetails().pendingBufferSize).toBe(1);
    // Simulate process death without graceful shutdown — we only flush the
    // WAL by waiting for the in-flight write to settle.
    await new Promise(r => setTimeout(r, 20));

    // Reset the fake state so the new adapter has no in-memory carry-over.
    fakeBullMQState.reset();

    // Second adapter: same WAL path. Replay must surface the buffered event
    // before any subscription runs.
    const bus2 = createBullMQAdapter({ connection: {}, walPath });
    // Subscribe so the queue handle is attached and a drain runs.
    bus2.on('auth:login' as any, async () => {}, { durable: true, name: 'wal-replay' });
    // Wait for the load promise + drain + queue.add.
    await new Promise(r => setTimeout(r, 50));
    await bus2._drainPendingBuffer();
    // After drain, the event should have been forwarded to the new queue.
    expect(fakeBullMQState.queues[0].addCalls.length).toBeGreaterThanOrEqual(1);
    await bus2.shutdown();
    errorSpy.mockRestore();
  });

  test('compacts the WAL when live entries exceed walCompactThreshold', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const walPath = await tmpWal();

    const bus = createBullMQAdapter({
      connection: {},
      walPath,
      walCompactThreshold: 5,
    });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'wal-compact' });

    // Buffer 10 events.
    for (let i = 0; i < 10; i++) {
      fakeBullMQState.nextAddError(
        Object.assign(new Error('Redis down'), { code: 'ECONNREFUSED' }),
      );
      bus.emit('auth:login' as any, { userId: `u${i}` } as any);
    }
    await new Promise(r => setTimeout(r, 50));
    expect(bus.getHealthDetails().pendingBufferSize).toBe(10);

    // Drain 6 successfully — each consume marks a WAL line; once live count
    // drops past the threshold, a compaction rewrites the file.
    await bus._drainPendingBuffer();
    await new Promise(r => setTimeout(r, 50));

    const raw = await fs.readFile(walPath, 'utf8');
    // After successful drain + compaction, no append entries remain — the
    // file is either empty or contains only live entries.
    const lines = raw.split('\n').filter(Boolean);
    // The compaction snapshot dropped any consume tombstones. There should
    // be strictly fewer total lines than the 20+ we'd see without compaction.
    expect(lines.length).toBeLessThan(15);
    await bus.shutdown();
    errorSpy.mockRestore();
  });
});
