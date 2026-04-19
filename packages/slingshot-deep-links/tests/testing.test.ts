import { afterEach, describe, expect, mock, test } from 'bun:test';

const pluginState = new Map<string, unknown>();

mock.module('@lastshotlabs/slingshot-core', () => ({
  getPluginState: () => pluginState,
}));

afterEach(() => {
  pluginState.clear();
  mock.restore();
});

describe('slingshot-deep-links testing helpers', () => {
  test('returns deep-links state from pluginState and null when absent', async () => {
    const { getDeepLinksState } = await import('../src/testing');
    const { DEEP_LINKS_PLUGIN_STATE_KEY } = await import('../src/stateKey');

    expect(getDeepLinksState({} as never)).toBeNull();

    const state = {
      config: { ios: { appId: 'com.example.app' } },
      aasaBody: '{"applinks":{}}',
      assetlinksBody: null,
    };
    pluginState.set(DEEP_LINKS_PLUGIN_STATE_KEY, state);

    expect(getDeepLinksState({} as never)).toEqual(state);
  });
});
