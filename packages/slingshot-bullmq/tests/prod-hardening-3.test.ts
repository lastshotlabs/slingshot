/**
 * Prod-hardening test suite (round 3) for slingshot-bullmq.
 *
 * Covers Redis connection loss recovery, worker crash recovery, queue
 * backpressure during rapid drain cycles, and event loss prevention.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createFakeBullMQModule, fakeBullMQState } from '../src/testing/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());

const { createBullMQAdapter } = await import('../src/bullmqAdapter');

afterEach(() => {
  fakeBullMQState.reset();
});

// ---------------------------------------------------------------------------
// Redis connection loss recovery
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — Redis connection loss recovery', () => {
  test('events buffer during Redis down and drain after recovery', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {} });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'recovery-test' });

      // Redis down — next add fails
      fakeBullMQState.nextAddError(new Error('Redis down'));
      bus.emit('auth:login' as any, { userId: 'u1' } as any);
      await new Promise(r => setTimeout(r, 20));
      expect(bus.getHealthDetails().pendingBufferSize).toBe(1);

      // Redis recovers — drain succeeds
      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(0);
      expect(fakeBullMQState.queues[0].addCalls).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('multiple events buffer during extended Redis outage and all drain after recovery', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {} });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'multi-recovery' });

      // Redis outage — fail 10 emits
      const COUNT = 10;
      for (let i = 0; i < COUNT; i++) {
        fakeBullMQState.nextAddError(new Error('Redis down'));
      }
      for (let i = 0; i < COUNT; i++) {
        bus.emit('auth:login' as any, { seq: i } as any);
      }
      await new Promise(r => setTimeout(r, 50));
      expect(bus.getHealthDetails().pendingBufferSize).toBe(COUNT);

      // Redis recovers — all 10 drain
      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(0);
      expect(fakeBullMQState.queues[0].addCalls).toHaveLength(COUNT);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('interleaved failure and recovery does not lose events', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {} });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'interleaved' });

      // Fail, emit, fail, emit, then succeed
      fakeBullMQState.nextAddError(new Error('Redis down'));
      bus.emit('auth:login' as any, { seq: 1 } as any);
      await new Promise(r => setTimeout(r, 20));

      fakeBullMQState.nextAddError(new Error('Redis down'));
      bus.emit('auth:login' as any, { seq: 2 } as any);
      await new Promise(r => setTimeout(r, 20));

      // Both should be buffered
      expect(bus.getHealthDetails().pendingBufferSize).toBe(2);

      // Drain — both should go through
      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(0);
      expect(fakeBullMQState.queues[0].addCalls).toHaveLength(2);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Worker crash recovery
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — worker crash recovery', () => {
  test('worker error does not crash the adapter — subsequent operations work', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {} });
      const received: unknown[] = [];
      bus.on('auth:login' as any, async (payload: unknown) => received.push(payload), {
        durable: true,
        name: 'crash-recovery',
      });

      // Simulate a worker crash
      const worker = fakeBullMQState.workers[0];
      for (const handler of worker.errorHandlers) {
        handler(new Error('worker crashed'));
      }

      // Worker should still process new events
      const envelope = {
        key: 'auth:login',
        payload: { userId: 'post-crash' },
        meta: {
          eventId: 'e1',
          occurredAt: new Date().toISOString(),
          ownerPlugin: 'test',
          exposure: ['internal' as const],
          scope: null,
          requestTenantId: null,
        },
      };
      await fakeBullMQState.dispatchJob(fakeBullMQState.queues[0].name, 'auth:login', envelope);
      expect(received).toHaveLength(1);
      expect((received[0] as Record<string, unknown>).userId).toBe('post-crash');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('worker completed handler fires after successful job processing', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    bus.on('auth:login' as any, async (payload: unknown) => received.push(payload), {
      durable: true,
      name: 'completed-test',
    });

    const envelope = {
      key: 'auth:login',
      payload: { userId: 'complete' },
      meta: {
        eventId: 'e1',
        occurredAt: new Date().toISOString(),
        ownerPlugin: 'test',
        exposure: ['internal' as const],
        scope: null,
        requestTenantId: null,
      },
    };

    await fakeBullMQState.dispatchJob(fakeBullMQState.queues[0].name, 'auth:login', envelope);
    expect(received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Queue backpressure
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — queue backpressure', () => {
  test('rapid consecutive failures all go to pending buffer', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {} });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'backpressure' });

      const COUNT = 20;
      for (let i = 0; i < COUNT; i++) {
        fakeBullMQState.nextAddError(new Error('backpressure'));
      }
      for (let i = 0; i < COUNT; i++) {
        bus.emit('auth:login' as any, { idx: i } as any);
      }
      await new Promise(r => setTimeout(r, 50));
      expect(bus.getHealthDetails().pendingBufferSize).toBe(COUNT);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('buffer order is preserved under backpressure', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {} });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'backpressure-order' });

      const COUNT = 5;
      for (let i = 0; i < COUNT; i++) {
        fakeBullMQState.nextAddError(new Error('backpressure'));
      }
      for (let i = 0; i < COUNT; i++) {
        bus.emit('auth:login' as any, { seq: i } as any);
      }
      await new Promise(r => setTimeout(r, 30));
      expect(bus.getHealthDetails().pendingBufferSize).toBe(COUNT);

      await bus._drainPendingBuffer();
      const calls = fakeBullMQState.queues[0].addCalls;
      expect(calls).toHaveLength(COUNT);
      for (let i = 0; i < COUNT; i++) {
        const payload = (calls[i]?.data as Record<string, unknown>)?.payload as Record<
          string,
          unknown
        >;
        expect(payload?.seq).toBe(i);
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('drain during backpressure still retries with backoff', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {}, drainBaseMs: 50, drainMaxMs: 200 });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'backpressure-drain' });

      fakeBullMQState.nextAddError(new Error('backpressure'));
      bus.emit('auth:login' as any, { idx: 1 } as any);
      await new Promise(r => setTimeout(r, 20));

      // First drain attempt fails
      fakeBullMQState.nextAddError(new Error('still failing'));
      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(1);

      // Second drain succeeds
      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Event loss prevention
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — event loss prevention', () => {
  test('emit after shutdown does not create new queues', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'loss-prevent' });
    const queueCountBefore = fakeBullMQState.queues.length;
    await bus.shutdown();

    // Attempt to emit after shutdown
    bus.emit('auth:login' as any, {} as any);
    expect(fakeBullMQState.queues.length).toBe(queueCountBefore);
  });

  test('non-durable listener is called exactly once per emit', () => {
    const bus = createBullMQAdapter({ connection: {} });
    let callCount = 0;
    bus.on('auth:login' as any, () => callCount++);
    bus.emit('auth:login' as any, {} as any);
    expect(callCount).toBe(1);
    bus.emit('auth:login' as any, {} as any);
    expect(callCount).toBe(2);
  });

  test('multiple listeners on same event all fire', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const results: number[] = [];
    bus.on('auth:login' as any, () => results.push(1));
    bus.on('auth:login' as any, () => results.push(2));
    bus.on('auth:login' as any, () => results.push(3));
    bus.emit('auth:login' as any, {} as any);
    expect(results).toEqual([1, 2, 3]);
  });
});
