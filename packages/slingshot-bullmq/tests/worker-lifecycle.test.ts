/**
 * Worker-lifecycle tests for createBullMQAdapter.
 *
 * Covers worker creation, error handling, graceful shutdown, and concurrent
 * worker behavior — complementing the existing worker-coverage in
 * prod-hardening-2.test.ts and bullmqAdapter.test.ts.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createFakeBullMQModule, fakeBullMQState } from '../src/testing/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());

const { createBullMQAdapter } = await import('../src/bullmqAdapter');

afterEach(() => {
  fakeBullMQState.reset();
});

// ---------------------------------------------------------------------------
// Worker creation
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — worker creation', () => {
  test('no workers exist before any durable subscription', () => {
    const bus = createBullMQAdapter({ connection: {} });
    expect(fakeBullMQState.workers).toHaveLength(0);
    expect(bus.getHealthDetails().workerCount).toBe(0);
  });

  test('durable subscription creates exactly one worker', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'w1' });
    expect(fakeBullMQState.workers).toHaveLength(1);
    expect(bus.getHealthDetails().workerCount).toBe(1);
  });

  test('two durable subscriptions for different events create two workers', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'w1' });
    bus.on('auth:logout' as any, async () => {}, { durable: true, name: 'w2' });
    expect(fakeBullMQState.workers).toHaveLength(2);
  });

  test('worker references the correct queue name', () => {
    const bus = createBullMQAdapter({ connection: {}, prefix: 'test' });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'ref-test' });
    const worker = fakeBullMQState.workers[0];
    const queue = fakeBullMQState.queues[0];
    expect(worker.queueName).toBe(queue.name);
  });
});

// ---------------------------------------------------------------------------
// Worker graceful shutdown
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — worker shutdown', () => {
  test('shutdown closes all workers', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'w-shutdown' });
    await bus.shutdown();
    expect(fakeBullMQState.workers[0].closed).toBe(true);
  });

  test('worker close is idempotent across multiple shutdown calls', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'w-idemp' });
    await bus.shutdown();
    await bus.shutdown();
    // Worker was already closed — second shutdown should not throw
    expect(fakeBullMQState.workers[0].closed).toBe(true);
  });

  test('workers are open before shutdown', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'w-open' });
    expect(fakeBullMQState.workers.every(w => w.closed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Worker error handling
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — worker error propagation', () => {
  test('worker paused count increments on worker error', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {} });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'w-error' });
      const worker = fakeBullMQState.workers[0];
      for (const handler of worker.errorHandlers) {
        handler(new Error('connection lost'));
      }
      expect(bus.getHealthDetails().workerPausedCount).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('multiple worker errors increment counter each time', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {} });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'w-multi-err' });
      const worker = fakeBullMQState.workers[0];
      for (const handler of worker.errorHandlers) {
        handler(new Error('error 1'));
        handler(new Error('error 2'));
        handler(new Error('error 3'));
      }
      expect(bus.getHealthDetails().workerPausedCount).toBe(3);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('workers across different events all have error handlers registered', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'w1' });
    bus.on('auth:logout' as any, async () => {}, { durable: true, name: 'w2' });
    for (const worker of fakeBullMQState.workers) {
      expect(worker.errorHandlers.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrent workers
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — concurrent workers', () => {
  test('workers for different events process independently', async () => {
    const loginCalls: unknown[] = [];
    const logoutCalls: unknown[] = [];

    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async (payload: unknown) => loginCalls.push(payload), {
      durable: true,
      name: 'con-w1',
    });
    bus.on('auth:logout' as any, async (payload: unknown) => logoutCalls.push(payload), {
      durable: true,
      name: 'con-w2',
    });

    const loginQueue = fakeBullMQState.queues.find(q => q.name.includes('auth_login'));
    const logoutQueue = fakeBullMQState.queues.find(q => q.name.includes('auth_logout'));

    const envelope = {
      key: 'auth:login',
      payload: { userId: 'u1' },
      meta: {
        eventId: 'e1',
        occurredAt: new Date().toISOString(),
        ownerPlugin: 'test',
        exposure: ['internal' as const],
        scope: null,
        requestTenantId: null,
      },
    };

    await fakeBullMQState.dispatchJob(loginQueue!.name, 'auth:login', envelope);
    await fakeBullMQState.dispatchJob(logoutQueue!.name, 'auth:logout', {
      ...envelope,
      key: 'auth:logout',
      payload: { userId: 'u1' },
    });

    expect(loginCalls).toHaveLength(1);
    expect(logoutCalls).toHaveLength(1);
  });
});
