import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createSearchTransformRegistry } from '../src/transformRegistry';
import type { SearchProvider } from '../src/types/provider';
import * as realDbNative from '../src/providers/dbNative';

const providerState = {
  factoryCalls: 0,
  failSecondConnectOnce: true,
  instances: [] as Array<{
    connect: ReturnType<typeof mock>;
    teardown: ReturnType<typeof mock>;
  }>,
};

const createDbNativeProviderSpy = spyOn(realDbNative, 'createDbNativeProvider').mockImplementation(
  () => {
    const id = providerState.factoryCalls++;
    const connect = mock(async () => {
      if (id === 1 && providerState.failSecondConnectOnce) {
        providerState.failSecondConnectOnce = false;
        throw new Error('connect failed once');
      }
    });
    const teardown = mock(async () => {});
    providerState.instances.push({ connect, teardown });
    return {
      name: `db-native-${id}`,
      connect,
      teardown,
    } as SearchProvider;
  },
);

const { createSearchManager } = await import('../src/searchManager');

afterEach(() => {
  providerState.factoryCalls = 0;
  providerState.failSecondConnectOnce = true;
  providerState.instances.length = 0;
  createDbNativeProviderSpy.mockRestore();
});

describe('search manager startup cleanup', () => {
  test('tears down already connected providers when initialization fails and allows retry', async () => {
    const manager = createSearchManager({
      pluginConfig: {
        providers: {
          first: { provider: 'db-native' },
          second: { provider: 'db-native' },
        },
      },
      transformRegistry: createSearchTransformRegistry(),
    });

    await expect(manager.initialize([])).rejects.toThrow('connect failed once');
    expect(providerState.instances).toHaveLength(2);
    expect(providerState.instances[0]?.teardown).toHaveBeenCalledTimes(1);
    expect(providerState.instances[1]?.teardown).toHaveBeenCalledTimes(1);

    await expect(manager.initialize([])).resolves.toBeUndefined();
    expect(providerState.factoryCalls).toBe(4);

    await manager.teardown();
  });
});
