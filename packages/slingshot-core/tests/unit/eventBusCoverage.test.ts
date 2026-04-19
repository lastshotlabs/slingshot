import { describe, expect, test } from 'bun:test';
import { InProcessAdapter, createInProcessAdapter } from '../../src/eventBus';

// ---------------------------------------------------------------------------
// InProcessAdapter.off() — lines 687-694
// ---------------------------------------------------------------------------

describe('InProcessAdapter.off()', () => {
  test('removes a previously registered listener', async () => {
    const bus = new InProcessAdapter();
    let called = false;
    const listener = () => {
      called = true;
    };

    bus.on('app:ready' as never, listener);
    bus.off('app:ready' as never, listener);

    bus.emit('app:ready', { plugins: [] });
    await bus.drain();

    expect(called).toBe(false);
  });

  test('off on event with no listeners is a no-op', () => {
    const bus = new InProcessAdapter();
    // Should not throw even if no listener was ever registered for this event
    expect(() => bus.off('app:ready' as never, () => {})).not.toThrow();
  });

  test('off removes only the specified listener', async () => {
    const bus = new InProcessAdapter();
    const calls: string[] = [];
    const listenerA = () => {
      calls.push('A');
    };
    const listenerB = () => {
      calls.push('B');
    };

    bus.on('app:ready' as never, listenerA);
    bus.on('app:ready' as never, listenerB);
    bus.off('app:ready' as never, listenerA);

    bus.emit('app:ready', { plugins: [] });
    await bus.drain();

    expect(calls).toEqual(['B']);
  });
});

// ---------------------------------------------------------------------------
// InProcessAdapter.shutdown() — lines 696-699
// ---------------------------------------------------------------------------

describe('InProcessAdapter.shutdown()', () => {
  test('clears all listeners', async () => {
    const bus = new InProcessAdapter();
    let called = false;
    bus.on('app:ready' as never, () => {
      called = true;
    });

    await bus.shutdown();

    // After shutdown, emitting should not invoke the cleared listener
    bus.emit('app:ready', { plugins: [] });
    await bus.drain();
    expect(called).toBe(false);
  });

  test('waits for pending handlers to settle', async () => {
    const bus = new InProcessAdapter();
    let finished = false;
    bus.on('app:ready' as never, async () => {
      await new Promise(r => setTimeout(r, 10));
      finished = true;
    });

    bus.emit('app:ready', { plugins: [] });
    await bus.shutdown();

    expect(finished).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createInProcessAdapter() factory — lines 727-729
// ---------------------------------------------------------------------------

describe('createInProcessAdapter()', () => {
  test('returns a bus with SlingshotEventBus interface', () => {
    const bus = createInProcessAdapter();
    expect(typeof bus.emit).toBe('function');
    expect(typeof bus.on).toBe('function');
    expect(typeof bus.off).toBe('function');
    expect(typeof bus.shutdown).toBe('function');
    expect(typeof bus.registerClientSafeEvents).toBe('function');
    expect(typeof bus.ensureClientSafeEventKey).toBe('function');
    expect(bus.clientSafeKeys).toBeDefined();
  });

  test('seeds client-safe keys from initial iterable', () => {
    const bus = createInProcessAdapter(['my:event.a', 'my:event.b']);
    expect(bus.clientSafeKeys.has('my:event.a')).toBe(true);
    expect(bus.clientSafeKeys.has('my:event.b')).toBe(true);
  });

  test('works without initial keys argument', () => {
    const bus = createInProcessAdapter();
    // Should at least have builtin keys
    expect(bus.clientSafeKeys.size).toBeGreaterThan(0);
  });

  test('each call returns an independent bus instance', () => {
    const bus1 = createInProcessAdapter();
    const bus2 = createInProcessAdapter();
    bus1.registerClientSafeEvents(['only-on-bus1:event']);
    expect(bus1.clientSafeKeys.has('only-on-bus1:event')).toBe(true);
    expect(bus2.clientSafeKeys.has('only-on-bus1:event')).toBe(false);
  });
});
