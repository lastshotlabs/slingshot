import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { attachContext } from '@lastshotlabs/slingshot-core';
import type { DeepLinksPluginState } from '../src/state';
import { DEEP_LINKS_PLUGIN_STATE_KEY } from '../src/stateKey';
import { getDeepLinksState } from '../src/testing';

// Uses a real attached context instead of mock.module('@lastshotlabs/slingshot-core'):
// Bun module mocks are process-wide and are NOT undone by mock.restore(), so a
// module mock here leaks into every test file that runs after this one.

describe('slingshot-deep-links testing helpers', () => {
  test('returns deep-links state from pluginState and null when absent', () => {
    const app = new Hono();
    const pluginState = new Map<string, unknown>();
    attachContext(app, {
      app,
      pluginState,
      ws: null,
      wsEndpoints: {},
      wsPublish: null,
    } as unknown as Parameters<typeof attachContext>[1]);

    expect(getDeepLinksState(app)).toBeNull();

    // Intentionally loose fixture shape — the helper only round-trips the value.
    const state = {
      config: { ios: { appId: 'com.example.app' } },
      aasaBody: '{"applinks":{}}',
      assetlinksBody: null,
    } as unknown as DeepLinksPluginState;
    pluginState.set(DEEP_LINKS_PLUGIN_STATE_KEY, state);

    expect(getDeepLinksState(app)).toEqual(state);
  });
});
