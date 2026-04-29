/**
 * Subscription-cleanup tests for createBullMQAdapter.
 *
 * Covers listener registration lifecycle, cleanup on shutdown,
 * multiple listener management, and behavior after unregistration.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createFakeBullMQModule, fakeBullMQState } from '../src/testing/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());

const { createBullMQAdapter } = await import('../src/bullmqAdapter');

afterEach(() => {
  fakeBullMQState.reset();
});

// ---------------------------------------------------------------------------
// Listener registration lifecycle
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — listener lifecycle', () => {
  test('on() with same listener registered twice fires twice per emit', () => {
    const bus = createBullMQAdapter({ connection: {} });
    let callCount = 0;
    const fn = () => callCount++;
    bus.on('auth:login' as any, fn);
    bus.on('auth:login' as any, fn);
    bus.emit('auth:login' as any, {} as any);
    expect(callCount).toBe(2);
  });

  test('off() removes only the specified listener, not others', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const calls: number[] = [];
    const fn1 = () => calls.push(1);
    const fn2 = () => calls.push(2);
    const fn3 = () => calls.push(3);
    bus.on('auth:login' as any, fn1);
    bus.on('auth:login' as any, fn2);
    bus.on('auth:login' as any, fn3);
    bus.off('auth:login' as any, fn2);
    bus.emit('auth:login' as any, {} as any);
    expect(calls).toEqual([1, 3]);
  });

  test('off() removes only listener for specified event, not other events', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const loginCalls: number[] = [];
    const logoutCalls: number[] = [];
    const fn = () => loginCalls.push(1);
    bus.on('auth:login' as any, fn);
    bus.on('auth:logout' as any, () => logoutCalls.push(1));
    bus.off('auth:login' as any, fn);
    bus.emit('auth:login' as any, {} as any);
    bus.emit('auth:logout' as any, {} as any);
    expect(loginCalls).toHaveLength(0);
    expect(logoutCalls).toHaveLength(1);
  });

  test('shutdown clears all non-durable listeners', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    const calls: unknown[] = [];
    bus.on('auth:login' as any, () => calls.push(true));
    bus.on('auth:logout' as any, () => calls.push(true));
    await bus.shutdown();
    bus.emit('auth:login' as any, {} as any);
    bus.emit('auth:logout' as any, {} as any);
    expect(calls).toHaveLength(0);
  });

  test('registering listener after shutdown still results in no-op emit', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    await bus.shutdown();
    const calls: unknown[] = [];
    bus.on('auth:login' as any, () => calls.push(true));
    bus.emit('auth:login' as any, {} as any);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Durable subscription lifecycle
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — durable subscription cleanup', () => {
  test('worker is created with the correct queue name', () => {
    const bus = createBullMQAdapter({ connection: {}, prefix: 'test' });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'worker-test' });
    const worker = fakeBullMQState.workers[0];
    const queue = fakeBullMQState.queues[0];
    expect(worker.queueName).toBe(queue.name);
  });

  test('off() throws for durable subscription with descriptive message', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const listener = async () => {};
    bus.on('auth:login' as any, listener, { durable: true, name: 'test-off' });
    expect(() => bus.off('auth:login' as any, listener)).toThrow('cannot remove a durable');
  });

  test('durable subscriptions are isolated per event', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'dup1' });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'dup2' });
    expect(fakeBullMQState.queues).toHaveLength(2);
  });
});
