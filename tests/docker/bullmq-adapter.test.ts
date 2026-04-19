// Docker integration tests for the slingshot-bullmq adapter (SlingshotEventBus contract).
// Requires: Redis on localhost:6380 (slingshot-redis-1 Docker container).
// Run with: bun test tests/docker/bullmq-adapter.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createBullMQAdapter } from '../../packages/slingshot-bullmq/src/bullmqAdapter';
import type { SlingshotEventBus } from '../../packages/slingshot-core/src/eventBus';

// Redis connection pointing at the Docker container (same as all other docker tests)
const REDIS_CONNECTION = { host: 'localhost', port: 6380 };

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Wait up to `ms` milliseconds for `condition` to become true, polling every 50 ms. */
async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 50));
  }
}

/** Unique suffix so parallel / repeated runs don't share queue state. */
const RUN_ID = Date.now();

function uniqueName(label: string): string {
  return `${label}-${RUN_ID}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Non-durable (EventEmitter) tests — no Redis involved
// ──────────────────────────────────────────────────────────────────────────────

describe('BullMQ adapter — non-durable subscriptions', () => {
  let bus: SlingshotEventBus & { shutdown(): Promise<void> };

  beforeAll(() => {
    bus = createBullMQAdapter({ connection: REDIS_CONNECTION }) as any;
  });

  afterAll(async () => {
    await bus.shutdown();
  });

  it('on(event, listener) → emit(event, payload) calls listener', async () => {
    const received: Array<{ userId: string; sessionId: string }> = [];

    const listener = (payload: { userId: string; sessionId: string }) => {
      received.push(payload);
    };

    bus.on('auth:login', listener);
    bus.emit('auth:login', { userId: 'u1', sessionId: 's1' });

    // Listeners are called fire-and-forget via Promise.resolve — give the
    // microtask queue one tick to settle before asserting.
    await new Promise(r => setTimeout(r, 20));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ userId: 'u1', sessionId: 's1' });
  });

  it('off(event, listener) → listener is not called after removal', async () => {
    const received: string[] = [];

    const listener = (payload: { userId: string; sessionId: string }) => {
      received.push(payload.userId);
    };

    bus.on('auth:logout', listener);
    bus.emit('auth:logout', { userId: 'u-before', sessionId: 's-before' });
    await new Promise(r => setTimeout(r, 20));
    expect(received).toHaveLength(1);

    bus.off('auth:logout', listener);
    bus.emit('auth:logout', { userId: 'u-after', sessionId: 's-after' });
    await new Promise(r => setTimeout(r, 20));

    // Should still be 1 — the second emit must not reach the removed listener
    expect(received).toHaveLength(1);
    expect(received[0]).toBe('u-before');
  });

  it('multiple non-durable listeners for the same event are all called', async () => {
    const calls: string[] = [];

    const l1 = () => {
      calls.push('l1');
    };
    const l2 = () => {
      calls.push('l2');
    };

    bus.on('app:ready', l1);
    bus.on('app:ready', l2);
    bus.emit('app:ready', { plugins: [] });

    await new Promise(r => setTimeout(r, 20));

    expect(calls).toContain('l1');
    expect(calls).toContain('l2');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Validation tests (no Redis required)
// ──────────────────────────────────────────────────────────────────────────────

describe('BullMQ adapter — validation', () => {
  it('on({ durable: true }) without name throws synchronously', () => {
    const bus = createBullMQAdapter({ connection: REDIS_CONNECTION });

    expect(() => {
      bus.on('auth:login', () => {}, { durable: true });
    }).toThrow('[BullMQAdapter] durable subscriptions require a name');
  });

  it('duplicate durable registration (same event + name) throws', () => {
    const bus = createBullMQAdapter({ connection: REDIS_CONNECTION });
    bus.on('auth:login', () => {}, { durable: true, name: uniqueName('dup-check') });

    expect(() => {
      bus.on('auth:login', () => {}, { durable: true, name: uniqueName('dup-check') });
    }).toThrow('already exists');
  });

  it('off() on a durable listener throws', () => {
    const bus = createBullMQAdapter({ connection: REDIS_CONNECTION });
    const listener = () => {};
    bus.on('auth:login', listener, { durable: true, name: uniqueName('off-durable') });

    expect(() => {
      bus.off('auth:login', listener);
    }).toThrow('cannot remove a durable subscription via off()');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Durable (BullMQ Queue + Worker) tests — Redis required
// ──────────────────────────────────────────────────────────────────────────────

describe('BullMQ adapter — durable subscriptions (Redis)', () => {
  // Each test gets its own isolated bus + unique queue names to prevent
  // cross-test interference (stale jobs from a previous run could be picked up).
  // We shut each bus down in afterAll.

  const buses: Array<SlingshotEventBus & { shutdown(): Promise<void> }> = [];

  afterAll(async () => {
    await Promise.all(buses.map(b => b.shutdown()));
  });

  function makeBus() {
    const b = createBullMQAdapter({ connection: REDIS_CONNECTION }) as SlingshotEventBus & {
      shutdown(): Promise<void>;
    };
    buses.push(b);
    return b;
  }

  it('durable on + emit immediately (no sleep) processes the job (regression: race condition fix)', async () => {
    const bus = makeBus();
    const received: Array<{ userId: string; sessionId: string }> = [];

    bus.on(
      'auth:login',
      payload => {
        received.push(payload);
      },
      { durable: true, name: uniqueName('login-no-sleep') },
    );

    // No artificial sleep — queue/worker setup is now synchronous.
    // emit() must reach the queue even without a delay.
    bus.emit('auth:login', { userId: 'u-immediate', sessionId: 's-immediate' });

    await waitFor(() => received.length >= 1, 5000);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ userId: 'u-immediate', sessionId: 's-immediate' });
  });

  it('durable on + emit → worker processes job and calls listener', async () => {
    const bus = makeBus();
    const received: Array<{ userId: string; sessionId: string }> = [];

    bus.on(
      'auth:login',
      payload => {
        received.push(payload);
      },
      { durable: true, name: uniqueName('login-basic') },
    );

    bus.emit('auth:login', { userId: 'u-durable', sessionId: 's-durable' });

    await waitFor(() => received.length >= 1, 5000);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ userId: 'u-durable', sessionId: 's-durable' });
  });

  it('multiple durable subscriptions for the same event all process the job', async () => {
    const bus = makeBus();
    const receivedA: string[] = [];
    const receivedB: string[] = [];

    bus.on(
      'auth:login',
      payload => {
        receivedA.push(payload.userId);
      },
      { durable: true, name: uniqueName('login-fanout-a') },
    );
    bus.on(
      'auth:login',
      payload => {
        receivedB.push(payload.userId);
      },
      { durable: true, name: uniqueName('login-fanout-b') },
    );

    bus.emit('auth:login', { userId: 'u-fanout', sessionId: 's-fanout' });

    await waitFor(() => receivedA.length >= 1 && receivedB.length >= 1, 5000);

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);
    expect(receivedA[0]).toBe('u-fanout');
    expect(receivedB[0]).toBe('u-fanout');
  });

  it('durable listener receives correct payload', async () => {
    const bus = makeBus();
    const received: Array<{ userId: string; email: string }> = [];

    bus.on(
      'auth:user.created',
      payload => {
        received.push({ userId: payload.userId, email: payload.email ?? '' });
      },
      { durable: true, name: uniqueName('user-created-payload') },
    );

    bus.emit('auth:user.created', { userId: 'u-new', email: 'test@example.com' });

    await waitFor(() => received.length >= 1, 5000);

    expect(received[0].userId).toBe('u-new');
    expect(received[0].email).toBe('test@example.com');
  });

  it('shutdown() closes workers and queues without hanging', async () => {
    const bus = makeBus();

    bus.on('auth:login', () => {}, { durable: true, name: uniqueName('shutdown-test') });

    // Should resolve without hanging (5s timeout is the test runner default)
    await expect(bus.shutdown()).resolves.toBeUndefined();

    // Remove from buses so afterAll doesn't double-close
    const idx = buses.indexOf(bus);
    if (idx !== -1) buses.splice(idx, 1);
  });
});
