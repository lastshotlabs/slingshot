/**
 * Event-publishing edge-case tests for createBullMQAdapter.
 *
 * Covers payload edge cases (null, empty, deeply nested, large arrays),
 * special characters in event names, and concurrent publishes.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createFakeBullMQModule, fakeBullMQState } from '../src/testing/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());

const { createBullMQAdapter } = await import('../src/bullmqAdapter');

afterEach(() => {
  fakeBullMQState.reset();
});

// ---------------------------------------------------------------------------
// Payload edge cases
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — payload edge cases', () => {
  test('emit with null payload delivers null to listener', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    bus.on('auth:login' as any, (payload: unknown) => received.push(payload));
    bus.emit('auth:login' as any, null as any);
    expect(received[0]).toBeNull();
  });

  test('emit with undefined payload delivers undefined to listener', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    bus.on('auth:login' as any, (payload: unknown) => received.push(payload));
    bus.emit('auth:login' as any, undefined as any);
    expect(received[0]).toBeUndefined();
  });

  test('emit with deeply nested object payload is delivered intact', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    const nested = { level1: { level2: { level3: { value: 'deep' } } } };
    bus.on('auth:login' as any, (payload: unknown) => received.push(payload));
    bus.emit('auth:login' as any, nested as any);
    expect(received[0]).toEqual(nested);
  });

  test('emit with numeric payload is delivered', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    bus.on('auth:login' as any, (payload: unknown) => received.push(payload));
    bus.emit('auth:login' as any, 42 as any);
    expect(received[0]).toBe(42);
  });

  test('emit with array payload is delivered', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    const items = ['a', 'b', 'c'];
    bus.on('auth:login' as any, (payload: unknown) => received.push(payload));
    bus.emit('auth:login' as any, items as any);
    expect(received[0]).toEqual(items);
  });
});

// ---------------------------------------------------------------------------
// Event name edge cases
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — event name edge cases', () => {
  test('event name with dots delivers to correct listener', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    bus.on('user.created' as any, (payload: unknown) => received.push(payload));
    bus.emit('user.created' as any, { id: 1 } as any);
    expect(received).toHaveLength(1);
  });

  test('event name with hyphens delivers to correct listener', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    bus.on('user-created' as any, (payload: unknown) => received.push(payload));
    bus.emit('user-created' as any, { id: 1 } as any);
    expect(received).toHaveLength(1);
  });

  test('event name with underscores delivers to correct listener', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    bus.on('user_created' as any, (payload: unknown) => received.push(payload));
    bus.emit('user_created' as any, { id: 1 } as any);
    expect(received).toHaveLength(1);
  });

  test('different event names do not cross-deliver', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const loginCalls: unknown[] = [];
    const otherCalls: unknown[] = [];
    bus.on('auth:login' as any, () => loginCalls.push(true));
    bus.on('app:init' as any, () => otherCalls.push(true));
    bus.emit('auth:login' as any, {} as any);
    expect(loginCalls).toHaveLength(1);
    expect(otherCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrent publishes
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — concurrent publishes', () => {
  test('10 concurrent emits on non-durable all deliver', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    bus.on('auth:login' as any, (payload: unknown) => received.push(payload));
    for (let i = 0; i < 10; i++) {
      bus.emit('auth:login' as any, { idx: i } as any);
    }
    expect(received).toHaveLength(10);
    expect((received[0] as Record<string, unknown>).idx).toBe(0);
    expect((received[9] as Record<string, unknown>).idx).toBe(9);
  });

  test('concurrent emits on different events do not interfere', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const loginCalls: unknown[] = [];
    const logoutCalls: unknown[] = [];
    bus.on('auth:login' as any, () => loginCalls.push(true));
    bus.on('auth:logout' as any, () => logoutCalls.push(true));

    // Interleave emits
    bus.emit('auth:login' as any, {} as any);
    bus.emit('auth:logout' as any, {} as any);
    bus.emit('auth:login' as any, {} as any);
    bus.emit('auth:logout' as any, {} as any);

    expect(loginCalls).toHaveLength(2);
    expect(logoutCalls).toHaveLength(2);
  });
});
