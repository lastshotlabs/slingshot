/**
 * Prod-hardening test suite (round 2) for slingshot-bullmq.
 *
 * Covers concurrency patterns, resource cleanup, drop signal propagation,
 * and drain-backoff reset — scenarios that complement the existing
 * P-BULLMQ-4/5/6/8 tests in bullmqAdapter.test.ts.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createFakeBullMQModule, fakeBullMQState } from '../src/testing/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());

const { createBullMQAdapter } = await import('../src/bullmqAdapter');

afterEach(() => {
  fakeBullMQState.reset();
});

// ---------------------------------------------------------------------------
// Concurrency — many rapid emits that all fail
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — concurrency', () => {
  test('50 rapid failed emits all end up in the pending buffer', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'rapid-fail' });
    const COUNT = 50;
    for (let i = 0; i < COUNT; i++) {
      fakeBullMQState.nextAddError(new Error('Redis down'));
    }
    for (let i = 0; i < COUNT; i++) {
      bus.emit('auth:login' as any, { idx: i } as any);
    }
    await new Promise(r => setTimeout(r, 50));
    expect(bus.getHealthDetails().pendingBufferSize).toBe(COUNT);
  });

  test('after 50 buffered events, drain succeeds and buffer empties', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'rapid-drain' });
    const COUNT = 50;
    for (let i = 0; i < COUNT; i++) {
      fakeBullMQState.nextAddError(new Error('Redis down'));
    }
    for (let i = 0; i < COUNT; i++) {
      bus.emit('auth:login' as any, { idx: i } as any);
    }
    await new Promise(r => setTimeout(r, 50));
    expect(bus.getHealthDetails().pendingBufferSize).toBe(COUNT);

    await bus._drainPendingBuffer();
    expect(bus.getHealthDetails().pendingBufferSize).toBe(0);
    expect(fakeBullMQState.queues[0]?.addCalls).toHaveLength(COUNT);
  });

  test('concurrent emit for different events isolates their queues', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'con-w1' });
    bus.on('auth:logout' as any, async () => {}, { durable: true, name: 'con-w2' });

    bus.emit('auth:login' as any, { seq: 1 } as any);
    bus.emit('auth:logout' as any, { seq: 2 } as any);
    bus.emit('auth:login' as any, { seq: 3 } as any);
    await new Promise(r => setTimeout(r, 20));

    const loginQueue = fakeBullMQState.queues.find(q => q.name.includes('auth_login'));
    const logoutQueue = fakeBullMQState.queues.find(q => q.name.includes('auth_logout'));
    expect(loginQueue?.addCalls).toHaveLength(2);
    expect(logoutQueue?.addCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Drain backoff resets
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — drain backoff reset', () => {
  test('drain backoff resets after buffer empties following a failure', async () => {
    const bus = createBullMQAdapter({ connection: {}, drainBaseMs: 50, drainMaxMs: 200 });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'backoff-reset' });

    // Buffer an event with a failure
    fakeBullMQState.nextAddError(new Error('Redis down'));
    bus.emit('auth:login' as any, {} as any);
    await new Promise(r => setTimeout(r, 20));
    expect(bus.getHealthDetails().pendingBufferSize).toBe(1);

    // First drain attempt — fails again (still no redis)
    fakeBullMQState.nextAddError(new Error('Redis down'));
    await bus._drainPendingBuffer();
    // Item stays buffered
    expect(bus.getHealthDetails().pendingBufferSize).toBe(1);

    // Now drain succeeds — buffer should be empty
    await bus._drainPendingBuffer();
    expect(bus.getHealthDetails().pendingBufferSize).toBe(0);

    // Buffer a new event after empty — fresh start, backoff count should be 0
    fakeBullMQState.nextAddError(new Error('Redis down'));
    bus.emit('auth:login' as any, {} as any);
    await new Promise(r => setTimeout(r, 20));
    expect(bus.getHealthDetails().pendingBufferSize).toBe(1);

    // This drain should succeed on first try (backoff was reset)
    await bus._drainPendingBuffer();
    expect(bus.getHealthDetails().pendingBufferSize).toBe(0);
    // Total add calls: 0 (first fail) + 0 (second fail) + 1 (first success) + 1 (after reset)
    expect(fakeBullMQState.queues[0]?.addCalls?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Worker error handling
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — worker error cleanup', () => {
  test('worker error increments workerPausedCount', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {} });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'error-worker' });
      const worker = fakeBullMQState.workers[0];
      // Fire the error handler
      for (const handler of worker.errorHandlers) {
        handler(new Error('worker crashed'));
      }
      expect(bus.getHealthDetails().workerPausedCount).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('worker error does not prevent subsequent successful dispatches', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {} });
      const received: unknown[] = [];
      bus.on('auth:login' as any, async (payload: unknown) => received.push(payload), {
        durable: true,
        name: 'resilient-worker',
      });
      const worker = fakeBullMQState.workers[0];
      // Fire the error handler
      for (const handler of worker.errorHandlers) {
        handler(new Error('transient blip'));
      }

      const envelope = {
        key: 'auth:login' as const,
        payload: { userId: 'post-error' },
        meta: {
          eventId: 'e1',
          occurredAt: new Date().toISOString(),
          ownerPlugin: 'test',
          exposure: ['internal' as const],
          scope: null,
          requestTenantId: null,
        },
      };
      const queueName = fakeBullMQState.queues[0].name;
      await fakeBullMQState.dispatchJob(queueName, 'auth:login', envelope);
      expect(received).toHaveLength(1);
      expect((received[0] as Record<string, unknown>).userId).toBe('post-error');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Permanent error propagation
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — permanent error drop signals', () => {
  test('permanent error (EINVAL) drops event and increments permanentErrorCount', async () => {
    const dropped: Array<{ event: string; reason: string }> = [];
    const bus = createBullMQAdapter({
      connection: {},
      onDrop: (event, reason) => dropped.push({ event, reason }),
    });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'perm-err' });

    fakeBullMQState.nextAddError(Object.assign(new Error('invalid'), { code: 'EINVAL' }));
    bus.emit('auth:login' as any, { userId: 'perm' } as any);
    await new Promise(r => setTimeout(r, 20));

    expect(dropped.some(d => d.reason === 'permanent-error')).toBe(true);
    expect(dropped.some(d => d.event === 'auth:login')).toBe(true);
    expect(bus.getHealthDetails().permanentErrorCount).toBe(1);
    // Not buffered
    expect(bus.getHealthDetails().pendingBufferSize).toBe(0);
  });

  test('unknown error code on initial emit is buffered (not permanently dropped)', async () => {
    const dropped: Array<{ event: string; reason: string }> = [];
    const bus = createBullMQAdapter({
      connection: {},
      onDrop: (event, reason) => dropped.push({ event, reason }),
    });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'unknown-err' });

    // Error with no recognized code — treated as unknown, buffered for retry
    fakeBullMQState.nextAddError(new Error('random unclassified error'));
    bus.emit('auth:login' as any, { userId: 'unknown' } as any);
    await new Promise(r => setTimeout(r, 20));

    // Should be buffered, not permanently dropped
    expect(dropped.some(d => d.reason === 'permanent-error')).toBe(false);
    expect(bus.getHealthDetails().pendingBufferSize).toBe(1);
  });

  test('WRONGTYPE error is classified as permanent and dropped', async () => {
    const dropped: Array<{ event: string; reason: string }> = [];
    const bus = createBullMQAdapter({
      connection: {},
      onDrop: (event, reason) => dropped.push({ event, reason }),
    });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'wrongtype-err' });

    fakeBullMQState.nextAddError(
      new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
    );
    bus.emit('auth:login' as any, { userId: 'wt' } as any);
    await new Promise(r => setTimeout(r, 20));

    expect(dropped.some(d => d.reason === 'permanent-error')).toBe(true);
    expect(bus.getHealthDetails().pendingBufferSize).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Buffer-full drop signal
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — buffer-full drop', () => {
  test('onDrop fires with buffer-full when buffer exceeds MAX_PENDING_BUFFER', async () => {
    const dropped: Array<{ event: string; reason: string }> = [];
    const bus = createBullMQAdapter({
      connection: {},
      onDrop: (event, reason) => dropped.push({ event, reason }),
    });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'buffer-full-test' });

    // Fill the buffer to capacity (MAX_PENDING_BUFFER = 1000)
    const MAX = 1000;
    for (let i = 0; i <= MAX; i++) fakeBullMQState.nextAddError(new Error('Redis down'));
    for (let i = 0; i < MAX; i++) bus.emit('auth:login' as any, { userId: `u${i}` } as any);
    await new Promise(r => setTimeout(r, 50));

    expect(bus.getHealthDetails().pendingBufferSize).toBe(MAX);

    // One more emit should trigger buffer-full drop
    bus.emit('auth:login' as any, { userId: 'overflow' } as any);
    await new Promise(r => setTimeout(r, 50));

    expect(dropped.some(d => d.reason === 'buffer-full')).toBe(true);
    expect(dropped.some(d => d.event === 'auth:login')).toBe(true);
    expect(bus.getHealthDetails().bufferDroppedCount).toBeGreaterThanOrEqual(1);
    // Buffer stays at capacity (oldest is NOT evicted — new is dropped)
    expect(bus.getHealthDetails().pendingBufferSize).toBe(MAX);
  });
});

// ---------------------------------------------------------------------------
// Pending buffer FIFO ordering
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — buffer ordering', () => {
  test('buffered events are drained in FIFO order', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'fifo-test' });

    // Buffer 5 events with sequential IDs
    for (let i = 0; i < 5; i++) {
      fakeBullMQState.nextAddError(new Error('Redis down'));
    }
    for (let i = 0; i < 5; i++) {
      bus.emit('auth:login' as any, { seq: i } as any);
    }
    await new Promise(r => setTimeout(r, 30));
    expect(bus.getHealthDetails().pendingBufferSize).toBe(5);

    // Drain all — they should appear in queue.addCalls in FIFO order
    await bus._drainPendingBuffer();
    expect(bus.getHealthDetails().pendingBufferSize).toBe(0);

    const calls = fakeBullMQState.queues[0]?.addCalls ?? [];
    expect(calls).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      const payload = (calls[i]?.data as Record<string, unknown>)?.payload as Record<
        string,
        unknown
      >;
      expect(payload?.seq).toBe(i);
    }
  });
});
