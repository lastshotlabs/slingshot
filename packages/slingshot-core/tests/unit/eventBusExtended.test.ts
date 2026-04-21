import { describe, expect, mock, test } from 'bun:test';
import {
  BUILTIN_CLIENT_SAFE_KEYS,
  FORBIDDEN_CLIENT_PREFIXES,
  InProcessAdapter,
} from '../../src/eventBus';

describe('InProcessAdapter', () => {
  // --- clientSafeKeys ---
  test('clientSafeKeys is seeded from BUILTIN_CLIENT_SAFE_KEYS', () => {
    const bus = new InProcessAdapter();
    for (const key of BUILTIN_CLIENT_SAFE_KEYS) {
      expect(bus.clientSafeKeys.has(key)).toBe(true);
    }
  });

  test('clientSafeKeys accepts custom initial keys', () => {
    const bus = new InProcessAdapter(['my:custom.event']);
    expect(bus.clientSafeKeys.has('my:custom.event')).toBe(true);
  });

  // --- registerClientSafeEvents ---
  test('registerClientSafeEvents adds allowed keys', () => {
    const bus = new InProcessAdapter();
    bus.registerClientSafeEvents(['my-plugin:thing.created']);
    expect(bus.clientSafeKeys.has('my-plugin:thing.created')).toBe(true);
  });

  test('registerClientSafeEvents throws on forbidden prefix', () => {
    const bus = new InProcessAdapter();
    expect(() => bus.registerClientSafeEvents(['security.auth.fake'])).toThrow('Cannot register');
    expect(() => bus.registerClientSafeEvents(['auth:user.created'])).toThrow('Cannot register');
    expect(() => bus.registerClientSafeEvents(['community:delivery.email'])).toThrow(
      'Cannot register',
    );
    expect(() => bus.registerClientSafeEvents(['push:notification'])).toThrow('Cannot register');
    expect(() => bus.registerClientSafeEvents(['app:ready'])).toThrow('Cannot register');
  });

  // --- ensureClientSafeEventKey ---
  test('ensureClientSafeEventKey returns key when registered', () => {
    const bus = new InProcessAdapter(['my:event']);
    expect(bus.ensureClientSafeEventKey('my:event')).toBe('my:event');
  });

  test('ensureClientSafeEventKey throws on forbidden prefix', () => {
    const bus = new InProcessAdapter();
    expect(() => bus.ensureClientSafeEventKey('security.auth.login', 'test')).toThrow(
      'cannot be streamed',
    );
  });

  test('ensureClientSafeEventKey throws when not registered', () => {
    const bus = new InProcessAdapter();
    expect(() => bus.ensureClientSafeEventKey('unregistered:event')).toThrow(
      'not registered as client-safe',
    );
  });

  test('ensureClientSafeEventKey uses default source in error', () => {
    const bus = new InProcessAdapter();
    expect(() => bus.ensureClientSafeEventKey('unregistered:event')).toThrow('SSE config');
  });

  // --- emit error handling ---
  test('sync listener error is caught and logged', async () => {
    const bus = new InProcessAdapter();
    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    bus.on('app:ready' as never, () => {
      throw new Error('sync boom');
    });
    bus.emit('app:ready', { plugins: [] });
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalled();
    console.error = originalError;
  });

  test('async listener error is caught and logged', async () => {
    const bus = new InProcessAdapter();
    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    bus.on('app:ready' as never, async () => {
      throw new Error('async boom');
    });
    bus.emit('app:ready', { plugins: [] });
    await bus.drain();

    expect(errorSpy).toHaveBeenCalled();
    console.error = originalError;
  });

  // --- drain ---
  test('drain resolves when no pending handlers', async () => {
    const bus = new InProcessAdapter();
    await expect(bus.drain()).resolves.toBeUndefined();
  });

  test('drain waits for pending handlers', async () => {
    const bus = new InProcessAdapter();
    let finished = false;
    bus.on('app:ready' as never, async () => {
      await new Promise(r => setTimeout(r, 10));
      finished = true;
    });
    bus.emit('app:ready', { plugins: [] });
    expect(finished).toBe(false);
    await bus.drain();
    expect(finished).toBe(true);
  });

  // --- emit to non-existent event ---
  test('emit to event with no listeners is a no-op', () => {
    const bus = new InProcessAdapter();
    expect(() => bus.emit('app:ready', { plugins: [] })).not.toThrow();
  });

  // --- ReadonlySet view operations ---
  test('clientSafeKeys size reflects backing set', () => {
    const bus = new InProcessAdapter(['a', 'b', 'c']);
    expect(bus.clientSafeKeys.size).toBe(3);
  });

  test('clientSafeKeys.has works', () => {
    const bus = new InProcessAdapter(['test:key']);
    expect(bus.clientSafeKeys.has('test:key')).toBe(true);
    expect(bus.clientSafeKeys.has('missing')).toBe(false);
  });

  test('clientSafeKeys forEach iterates entries', () => {
    const bus = new InProcessAdapter(['a', 'b']);
    const collected: string[] = [];
    bus.clientSafeKeys.forEach(v => collected.push(v));
    expect(collected).toContain('a');
    expect(collected).toContain('b');
  });

  test('clientSafeKeys entries/keys/values iterate correctly', () => {
    const bus = new InProcessAdapter(['x']);
    expect([...bus.clientSafeKeys.keys()]).toContain('x');
    expect([...bus.clientSafeKeys.values()]).toContain('x');
    const entries = [...bus.clientSafeKeys.entries()];
    expect(entries.some(([k, v]) => k === 'x' && v === 'x')).toBe(true);
  });

  test('clientSafeKeys [Symbol.iterator] works', () => {
    const bus = new InProcessAdapter(['y']);
    expect([...bus.clientSafeKeys]).toContain('y');
  });

  test('clientSafeKeys union', () => {
    const bus = new InProcessAdapter(['a', 'b']);
    const other = new Set(['b', 'c']);
    const result = bus.clientSafeKeys.union(other);
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(true);
    expect(result.has('c')).toBe(true);
  });

  test('clientSafeKeys intersection', () => {
    const bus = new InProcessAdapter(['a', 'b', 'c']);
    const other = new Set(['b', 'c', 'd']);
    const result = bus.clientSafeKeys.intersection(other);
    expect(result.has('a')).toBe(false);
    expect(result.has('b')).toBe(true);
    expect(result.has('c')).toBe(true);
  });

  test('clientSafeKeys difference', () => {
    const bus = new InProcessAdapter(['a', 'b', 'c']);
    const other = new Set(['b']);
    const result = bus.clientSafeKeys.difference(other);
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(false);
    expect(result.has('c')).toBe(true);
  });

  test('clientSafeKeys symmetricDifference', () => {
    const bus = new InProcessAdapter(['a', 'b']);
    const other = new Set(['b', 'c']);
    const result = bus.clientSafeKeys.symmetricDifference(other);
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(false);
    expect(result.has('c')).toBe(true);
  });

  test('clientSafeKeys isSubsetOf', () => {
    const bus = new InProcessAdapter(['a', 'b']);
    expect(bus.clientSafeKeys.isSubsetOf(new Set(['a', 'b', 'c']))).toBe(true);
    expect(bus.clientSafeKeys.isSubsetOf(new Set(['a']))).toBe(false);
  });

  test('clientSafeKeys isSupersetOf', () => {
    const bus = new InProcessAdapter(['a', 'b', 'c']);
    expect(bus.clientSafeKeys.isSupersetOf(new Set(['a', 'b']))).toBe(true);
    expect(bus.clientSafeKeys.isSupersetOf(new Set(['a', 'd']))).toBe(false);
  });

  test('clientSafeKeys isDisjointFrom', () => {
    const bus = new InProcessAdapter(['a', 'b']);
    expect(bus.clientSafeKeys.isDisjointFrom(new Set(['c', 'd']))).toBe(true);
    expect(bus.clientSafeKeys.isDisjointFrom(new Set(['b', 'c']))).toBe(false);
  });

  test('clientSafeKeys is frozen', () => {
    const bus = new InProcessAdapter(['a']);
    expect(Object.isFrozen(bus.clientSafeKeys)).toBe(true);
  });
});

describe('FORBIDDEN_CLIENT_PREFIXES', () => {
  test('contains expected prefixes', () => {
    expect(FORBIDDEN_CLIENT_PREFIXES).toContain('security.');
    expect(FORBIDDEN_CLIENT_PREFIXES).toContain('auth:');
    expect(FORBIDDEN_CLIENT_PREFIXES).toContain('push:');
    expect(FORBIDDEN_CLIENT_PREFIXES).toContain('app:');
  });
});
