import { describe, expect, mock, test } from 'bun:test';
import type { SlingshotEventBus } from '../../src/eventBus';
import { createRouterAdapter } from '../../src/routerAdapter';

function createMockBus(keys: string[] = []): SlingshotEventBus {
  return {
    emit: mock(() => {}),
    on: mock(() => {}),
    off: mock(() => {}),
    onEnvelope: mock(() => {}),
    offEnvelope: mock(() => {}),
    shutdown: mock(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// emit — line 130-131
// ---------------------------------------------------------------------------

describe('RouterAdapter.emit()', () => {
  test('routes emit to default adapter when no namespace matches', () => {
    const defaultBus = createMockBus();
    const router = createRouterAdapter({ default: defaultBus });

    const payload = { plugins: [] };
    router.emit('app:ready' as never, payload as never);

    expect(defaultBus.emit).toHaveBeenCalledWith('app:ready', { plugins: [] });
  });

  test('routes emit to namespace adapter when prefix matches', () => {
    const defaultBus = createMockBus();
    const nsBus = createMockBus();
    const router = createRouterAdapter({
      default: defaultBus,
      namespaces: { 'community:': nsBus },
    });

    const emptyPayload = {};
    router.emit('community:thread.created' as never, emptyPayload as never);

    expect(nsBus.emit).toHaveBeenCalled();
    expect(defaultBus.emit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// on — lines 134-139
// ---------------------------------------------------------------------------

describe('RouterAdapter.on()', () => {
  test('routes on to default adapter when no namespace matches', () => {
    const defaultBus = createMockBus();
    const router = createRouterAdapter({ default: defaultBus });
    const listener = () => {};

    router.on('app:ready' as never, listener as never);

    expect(defaultBus.on).toHaveBeenCalled();
  });

  test('routes on to namespace adapter when prefix matches', () => {
    const defaultBus = createMockBus();
    const nsBus = createMockBus();
    const router = createRouterAdapter({
      default: defaultBus,
      namespaces: { 'ns:': nsBus },
    });
    const listener = () => {};

    router.on('ns:some.event' as never, listener as never);

    expect(nsBus.on).toHaveBeenCalled();
    expect(defaultBus.on).not.toHaveBeenCalled();
  });

  test('passes subscription opts through to the resolved adapter', () => {
    const defaultBus = createMockBus();
    const router = createRouterAdapter({ default: defaultBus });
    const listener = () => {};
    const subOpts = { durable: true, name: 'test-sub' };

    router.on('app:ready' as never, listener as never, subOpts);

    expect(defaultBus.on).toHaveBeenCalledWith('app:ready', listener, subOpts);
  });
});

// ---------------------------------------------------------------------------
// off — lines 142-147
// ---------------------------------------------------------------------------

describe('RouterAdapter.off()', () => {
  test('routes off to default adapter when no namespace matches', () => {
    const defaultBus = createMockBus();
    const router = createRouterAdapter({ default: defaultBus });
    const listener = () => {};

    router.off('app:ready' as never, listener as never);

    expect(defaultBus.off).toHaveBeenCalledWith('app:ready', listener);
  });

  test('routes off to namespace adapter when prefix matches', () => {
    const defaultBus = createMockBus();
    const nsBus = createMockBus();
    const router = createRouterAdapter({
      default: defaultBus,
      namespaces: { 'ns:': nsBus },
    });
    const listener = () => {};

    router.off('ns:some.event' as never, listener as never);

    expect(nsBus.off).toHaveBeenCalledWith('ns:some.event', listener);
    expect(defaultBus.off).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// shutdown — lines 149-153
// ---------------------------------------------------------------------------

describe('RouterAdapter.shutdown()', () => {
  test('calls shutdown on all adapters', async () => {
    const defaultBus = createMockBus();
    const nsBus = createMockBus();
    const router = createRouterAdapter({
      default: defaultBus,
      namespaces: { 'ns:': nsBus },
    });

    await router.shutdown!();

    expect(defaultBus.shutdown).toHaveBeenCalled();
    expect(nsBus.shutdown).toHaveBeenCalled();
  });

  test('shutdown works when adapter has no shutdown method', async () => {
    const defaultBus = createMockBus();
    delete (defaultBus as unknown as Record<string, unknown>).shutdown;
    const router = createRouterAdapter({ default: defaultBus });

    // Should not throw even if shutdown is undefined
    await expect(router.shutdown!()).resolves.toBeUndefined();
  });

  test('shutdown calls each adapter only once even if same instance is used', async () => {
    const sharedBus = createMockBus();
    const router = createRouterAdapter({
      default: sharedBus,
      namespaces: { 'ns:': sharedBus },
    });

    await router.shutdown!();

    // allAdapters() uses a Set to deduplicate — should only be called once
    expect(sharedBus.shutdown).toHaveBeenCalledTimes(1);
  });
});
