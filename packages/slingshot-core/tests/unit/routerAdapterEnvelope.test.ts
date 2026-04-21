import { describe, expect, mock, test } from 'bun:test';
import type { EventEnvelope, SlingshotEventBus } from '../../src';
import { createRouterAdapter } from '../../src';

function createMockBus(): SlingshotEventBus {
  return {
    emit: mock(() => {}),
    on: mock(() => {}),
    onEnvelope: mock(() => {}),
    off: mock(() => {}),
    offEnvelope: mock(() => {}),
    shutdown: mock(async () => {}),
  } as unknown as SlingshotEventBus;
}

describe('routerAdapter envelope routing', () => {
  test('routes envelope subscriptions to the resolved namespace adapter', () => {
    const defaultBus = createMockBus();
    const authBus = createMockBus();
    const router = createRouterAdapter({
      default: defaultBus,
      namespaces: { 'auth:': authBus },
    });
    const listener = mock((_envelope: EventEnvelope<'auth:login'>) => {});

    router.onEnvelope('auth:login', listener);

    expect(authBus.onEnvelope).toHaveBeenCalledWith('auth:login', listener, undefined);
    expect(defaultBus.onEnvelope).not.toHaveBeenCalled();
  });
});
