import { describe, expect, mock, test } from 'bun:test';
import type { SlingshotEventBus } from '../../src/eventBus';
import { createRouterAdapter } from '../../src/routerAdapter';

function createMockBus(keys: string[] = []) {
  const clientSafe = new Set<string>(keys);
  const bus: SlingshotEventBus = {
    emit: mock(() => {}),
    on: mock(() => {}),
    off: mock(() => {}),
    shutdown: mock(async () => {}),
    clientSafeKeys: clientSafe,
    registerClientSafeEvents: mock((newKeys: string[]) => {
      for (const k of newKeys) clientSafe.add(k);
    }),
    ensureClientSafeEventKey: mock((key: string) => key),
  };
  return bus;
}

describe('RouterAdapter clientSafeKeys', () => {
  test('clientSafeKeys is union of all adapters', () => {
    const defaultBus = createMockBus(['a', 'b']);
    const nsBus = createMockBus(['b', 'c']);
    const router = createRouterAdapter({
      default: defaultBus,
      namespaces: { 'ns.': nsBus },
    });
    const keys = router.clientSafeKeys;
    expect(keys.has('a')).toBe(true);
    expect(keys.has('b')).toBe(true);
    expect(keys.has('c')).toBe(true);
  });
});

describe('RouterAdapter registerClientSafeEvents', () => {
  test('forwards to all adapters', () => {
    const defaultBus = createMockBus();
    const nsBus = createMockBus();
    const router = createRouterAdapter({
      default: defaultBus,
      namespaces: { 'ns.': nsBus },
    });
    router.registerClientSafeEvents(['my:event']);
    expect(defaultBus.registerClientSafeEvents).toHaveBeenCalledWith(['my:event']);
    expect(nsBus.registerClientSafeEvents).toHaveBeenCalledWith(['my:event']);
  });
});

describe('RouterAdapter ensureClientSafeEventKey', () => {
  test('routes to resolved adapter', () => {
    const defaultBus = createMockBus();
    const nsBus = createMockBus();
    const router = createRouterAdapter({
      default: defaultBus,
      namespaces: { 'ns.': nsBus },
    });
    router.ensureClientSafeEventKey('ns.some.event', 'test');
    expect(nsBus.ensureClientSafeEventKey).toHaveBeenCalledWith('ns.some.event', 'test');
    expect(defaultBus.ensureClientSafeEventKey).not.toHaveBeenCalled();
  });

  test('routes to default when no namespace match', () => {
    const defaultBus = createMockBus();
    const router = createRouterAdapter({ default: defaultBus });
    router.ensureClientSafeEventKey('unmatched.event');
    expect(defaultBus.ensureClientSafeEventKey).toHaveBeenCalled();
  });
});
