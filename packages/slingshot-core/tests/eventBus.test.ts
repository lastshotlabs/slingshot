import { describe, expect, mock, test } from 'bun:test';
import { createInProcessAdapter } from '../src/eventBus';

describe('InProcessAdapter (createInProcessAdapter)', () => {
  test('on + emit: listener is called with the emitted payload', async () => {
    const bus = createInProcessAdapter();
    const listener = mock(() => {});
    bus.on('app:ready', listener);
    bus.emit('app:ready', { plugins: ['a'] });
    // emit is fire-and-forget; give microtasks a tick to settle
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ plugins: ['a'] });
  });

  test('off removes the listener — after off, listener no longer fires', async () => {
    const bus = createInProcessAdapter();
    const listener = mock(() => {});
    bus.on('app:shutdown', listener);
    bus.off('app:shutdown', listener);
    bus.emit('app:shutdown', { signal: 'SIGTERM' });
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });

  test('multiple listeners for the same event all fire', async () => {
    const bus = createInProcessAdapter();
    const listenerA = mock(() => {});
    const listenerB = mock(() => {});
    bus.on('auth:login', listenerA);
    bus.on('auth:login', listenerB);
    bus.emit('auth:login', { userId: 'u1', sessionId: 's1' });
    await Promise.resolve();
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
  });

  test('listener is not called for a different event', async () => {
    const bus = createInProcessAdapter();
    const listener = mock(() => {});
    bus.on('app:ready', listener);
    bus.emit('app:shutdown', { signal: 'SIGINT' });
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });

  test('durable subscription with name degrades gracefully — no error thrown, listener still fires', async () => {
    const bus = createInProcessAdapter();
    const listener = mock(() => {});
    expect(() => {
      bus.on('auth:login', listener, { durable: true, name: 'my-durable-sub' });
    }).not.toThrow();
    bus.emit('auth:login', { userId: 'u1', sessionId: 's1' });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('durable subscription without name throws', () => {
    const bus = createInProcessAdapter();
    const listener = mock(() => {});
    expect(() => {
      bus.on('auth:login', listener, { durable: true });
    }).toThrow('durable subscriptions require a name');
  });

  test('shutdown removes all listeners — emit after shutdown is a no-op', async () => {
    const bus = createInProcessAdapter();
    const listener = mock(() => {});
    bus.on('app:ready', listener);
    await bus.shutdown?.();
    bus.emit('app:ready', { plugins: [] });
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });

  test('shutdown waits for in-flight async listeners before resolving', async () => {
    const bus = createInProcessAdapter();
    const blocker = Promise.withResolvers<undefined>();
    let finished = false;

    bus.on('app:ready', async () => {
      await blocker.promise;
      finished = true;
    });

    bus.emit('app:ready', { plugins: ['alpha'] });

    let shutdownResolved = false;
    const shutdownPromise = bus.shutdown?.().then(() => {
      shutdownResolved = true;
    });

    await Promise.resolve();
    expect(finished).toBe(false);
    expect(shutdownResolved).toBe(false);

    blocker.resolve();
    await shutdownPromise;

    expect(finished).toBe(true);
    expect(shutdownResolved).toBe(true);
  });

  test('off does not affect other listeners for the same event', async () => {
    const bus = createInProcessAdapter();
    const listenerA = mock(() => {});
    const listenerB = mock(() => {});
    bus.on('app:ready', listenerA);
    bus.on('app:ready', listenerB);
    bus.off('app:ready', listenerA);
    bus.emit('app:ready', { plugins: [] });
    await Promise.resolve();
    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).toHaveBeenCalledTimes(1);
  });
});
