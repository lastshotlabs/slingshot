/**
 * Event-routing tests for createBullMQAdapter.
 *
 * Covers routing isolation between different event types, between
 * durable and non-durable subscriptions, and correct payload delivery.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createFakeBullMQModule, fakeBullMQState } from '../src/testing/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());

const { createBullMQAdapter } = await import('../src/bullmqAdapter');

afterEach(() => {
  fakeBullMQState.reset();
});

// ---------------------------------------------------------------------------
// Event isolation
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — event isolation', () => {
  test('emit for one event does not trigger listener of another event', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const calls: string[] = [];
    bus.on('auth:login' as any, () => calls.push('login'));
    bus.on('auth:logout' as any, () => calls.push('logout'));
    bus.emit('auth:login' as any, {} as any);
    expect(calls).toEqual(['login']);
  });

  test('emit with no listeners produces no error', () => {
    const bus = createBullMQAdapter({ connection: {} });
    expect(() => bus.emit('auth:login' as any, {} as any)).not.toThrow();
  });

  test('emit for event with only durable subscription still delivers non-durable payload', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    bus.on('auth:login' as any, async (payload: unknown) => received.push(payload), {
      durable: true,
      name: 'route-test',
    });

    bus.emit('auth:login' as any, { userId: 'route' } as any);
    await new Promise(r => setTimeout(r, 20));

    // Durable queue should have the event
    expect(fakeBullMQState.queues[0].addCalls).toHaveLength(1);
    const addCallData = fakeBullMQState.queues[0].addCalls[0].data as Record<string, unknown>;
    expect((addCallData.payload as Record<string, unknown>).userId).toBe('route');
  });

  test('payload objects with prototype properties are delivered', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    class UserPayload {
      userId = 'u1';
      role = 'admin';
    }
    bus.on('auth:login' as any, (payload: unknown) => received.push(payload));
    bus.emit('auth:login' as any, new UserPayload() as any);
    expect(received).toHaveLength(1);
    expect((received[0] as Record<string, unknown>).userId).toBe('u1');
    expect((received[0] as Record<string, unknown>).role).toBe('admin');
  });
});

// ---------------------------------------------------------------------------
// Route to multiple subscription types
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — mixed subscription types', () => {
  test('non-durable and durable listen on same event both get the payload', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    const nonDurableCalls: unknown[] = [];
    const durableCalls: unknown[] = [];

    bus.on('auth:login' as any, (payload: unknown) => nonDurableCalls.push(payload));
    bus.on('auth:login' as any, async (payload: unknown) => durableCalls.push(payload), {
      durable: true,
      name: 'mixed-test',
    });

    bus.emit('auth:login' as any, { userId: 'mixed' } as any);
    await new Promise(r => setTimeout(r, 20));

    expect(nonDurableCalls).toHaveLength(1);
    expect((nonDurableCalls[0] as Record<string, unknown>).userId).toBe('mixed');
    expect(fakeBullMQState.queues[0].addCalls).toHaveLength(1);
  });

  test('non-durable listener receives payload immediately', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    bus.on('auth:login' as any, (payload: unknown) => received.push(payload));
    bus.emit('auth:login' as any, { value: 42 } as any);
    expect(received).toHaveLength(1);
    expect((received[0] as Record<string, unknown>).value).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Multiple events
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — multiple events routing', () => {
  test('four distinct events each route to their own listener', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const calls: Record<string, number> = {};

    const events = ['e1', 'e2', 'e3', 'e4'];
    for (const e of events) {
      calls[e] = 0;
      bus.on(e as any, () => calls[e]++);
    }

    bus.emit('e1' as any, {} as any);
    bus.emit('e3' as any, {} as any);
    bus.emit('e1' as any, {} as any);

    expect(calls).toEqual({ e1: 2, e2: 0, e3: 1, e4: 0 });
  });
});
