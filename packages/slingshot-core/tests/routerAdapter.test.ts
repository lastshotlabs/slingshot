import { describe, expect, mock, test } from 'bun:test';
import type { SlingshotEventBus } from '../src/eventBus';
import { createRouterAdapter } from '../src/routerAdapter';

function createMockBus() {
  const emitFn = mock((): void => {});
  const onFn = mock((): void => {});
  const offFn = mock((): void => {});
  const onEnvelopeFn = mock((): void => {});
  const offEnvelopeFn = mock((): void => {});
  const shutdownFn = mock((): Promise<void> => Promise.resolve());

  const bus: SlingshotEventBus = {
    emit: emitFn,
    on: onFn,
    off: offFn,
    onEnvelope: onEnvelopeFn,
    offEnvelope: offEnvelopeFn,
    shutdown: shutdownFn,
  };

  return {
    bus,
    emitFn,
    onFn,
    offFn,
    onEnvelopeFn,
    offEnvelopeFn,
    shutdownFn,
  };
}

describe('RouterAdapter', () => {
  test('falls back to default when namespaces is undefined', () => {
    const { bus: defaultBus, emitFn: defaultEmit } = createMockBus();
    const router = createRouterAdapter({ default: defaultBus });
    router.emit('app:ready', { plugins: [] });
    expect(defaultEmit).toHaveBeenCalledTimes(1);
  });

  test('falls back to default when no namespace matches', () => {
    const { bus: defaultBus, emitFn: defaultEmit } = createMockBus();
    const { bus: securityBus, emitFn: securityEmit } = createMockBus();
    const router = createRouterAdapter({
      default: defaultBus,
      namespaces: { 'security.': securityBus },
    });
    router.emit('app:ready', { plugins: [] });
    expect(defaultEmit).toHaveBeenCalledTimes(1);
    expect(securityEmit).not.toHaveBeenCalled();
  });

  test('routes to matching namespace by prefix', () => {
    const { bus: defaultBus, emitFn: defaultEmit } = createMockBus();
    const { bus: securityBus, emitFn: securityEmit } = createMockBus();
    const router = createRouterAdapter({
      default: defaultBus,
      namespaces: { 'security.': securityBus },
    });
    router.emit('security.auth.login.success', { userId: 'u1' });
    expect(securityEmit).toHaveBeenCalledTimes(1);
    expect(defaultEmit).not.toHaveBeenCalled();
  });

  test('longest prefix wins', () => {
    const { bus: defaultBus, emitFn: defaultEmit } = createMockBus();
    const { bus: shortBus, emitFn: shortEmit } = createMockBus();
    const { bus: longBus, emitFn: longEmit } = createMockBus();
    const router = createRouterAdapter({
      default: defaultBus,
      namespaces: {
        'security.': shortBus,
        'security.auth.': longBus,
      },
    });
    router.emit('security.auth.login.success', { userId: 'u1' });
    expect(longEmit).toHaveBeenCalledTimes(1);
    expect(shortEmit).not.toHaveBeenCalled();
    expect(defaultEmit).not.toHaveBeenCalled();
  });

  test('shutdown deduplicates by reference — shared adapter shut down exactly once', async () => {
    const { bus: sharedBus, shutdownFn } = createMockBus();
    const router = createRouterAdapter({
      default: sharedBus,
      namespaces: { 'security.': sharedBus }, // same reference as default
    });
    await router.shutdown?.();
    expect(shutdownFn).toHaveBeenCalledTimes(1);
  });

  test('shutdown calls each unique adapter once', async () => {
    const { bus: defaultBus, shutdownFn: defaultShutdown } = createMockBus();
    const { bus: securityBus, shutdownFn: securityShutdown } = createMockBus();
    const router = createRouterAdapter({
      default: defaultBus,
      namespaces: { 'security.': securityBus },
    });
    await router.shutdown?.();
    expect(defaultShutdown).toHaveBeenCalledTimes(1);
    expect(securityShutdown).toHaveBeenCalledTimes(1);
  });

  test('on routes to resolved adapter', () => {
    const { bus: defaultBus, onFn: defaultOn } = createMockBus();
    const { bus: securityBus, onFn: securityOn } = createMockBus();
    const router = createRouterAdapter({
      default: defaultBus,
      namespaces: { 'security.': securityBus },
    });
    const listener = (): void => {};
    router.on('security.auth.login.success', listener);
    expect(securityOn).toHaveBeenCalledTimes(1);
    expect(defaultOn).not.toHaveBeenCalled();
  });

  test('off routes to resolved adapter', () => {
    const { bus: defaultBus, offFn: defaultOff } = createMockBus();
    const { bus: securityBus, offFn: securityOff } = createMockBus();
    const router = createRouterAdapter({
      default: defaultBus,
      namespaces: { 'security.': securityBus },
    });
    const listener = (): void => {};
    router.off('security.auth.login.success', listener);
    expect(securityOff).toHaveBeenCalledTimes(1);
    expect(defaultOff).not.toHaveBeenCalled();
  });
});
