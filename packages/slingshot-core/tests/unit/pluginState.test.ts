import { describe, expect, test } from 'bun:test';
import { attachContext } from '../../src/context/index';
import {
  createPluginStateMap,
  getPluginState,
  getPluginStateFromRequest,
  getPluginStateFromRequestOrNull,
  getPluginStateOrNull,
  isPluginStateSealed,
  maybeEntityAdapter,
  publishEntityAdaptersState,
  publishPluginState,
  requireEntityAdapter,
  resolvePluginState,
  sealPluginState,
} from '../../src/pluginState';

describe('resolvePluginState', () => {
  test('returns Map directly when input is a Map', () => {
    const map = new Map([['key', 'value']]);
    expect(resolvePluginState(map)).toBe(map);
  });

  test('returns pluginState from a carrier object', () => {
    const map = new Map([['key', 'value']]);
    const carrier = { pluginState: map };
    expect(resolvePluginState(carrier)).toBe(map);
  });

  test('returns null for null input', () => {
    expect(resolvePluginState(null)).toBeNull();
  });

  test('returns null for undefined input', () => {
    expect(resolvePluginState(undefined)).toBeNull();
  });

  test('returns null for plain object without pluginState', () => {
    const objData = { foo: 'bar' };
    const obj: never = objData as never;
    expect(resolvePluginState(obj)).toBeNull();
  });
});

describe('getPluginStateOrNull', () => {
  test('returns null for null input', () => {
    expect(getPluginStateOrNull(null)).toBeNull();
  });

  test('returns null for undefined input', () => {
    expect(getPluginStateOrNull(undefined)).toBeNull();
  });

  test('returns null for non-object input (string)', () => {
    expect(getPluginStateOrNull('not-an-object' as never)).toBeNull();
  });

  test('returns null for non-object input (number)', () => {
    expect(getPluginStateOrNull(42 as never)).toBeNull();
  });

  test('returns Map from direct Map input', () => {
    const map = new Map();
    expect(getPluginStateOrNull(map)).toBe(map);
  });

  test('returns Map from carrier input', () => {
    const map = new Map();
    expect(getPluginStateOrNull({ pluginState: map })).toBe(map);
  });
});

describe('getPluginState', () => {
  test('returns pluginState from Map', () => {
    const map = new Map();
    expect(getPluginState(map)).toBe(map);
  });

  test('throws when pluginState not available', () => {
    const objData = {};
    const obj: never = objData as never;
    expect(() => getPluginState(obj)).toThrow('pluginState is not available for this app');
  });
});

describe('guarded plugin state', () => {
  test('allows bootstrap publication and rejects mutations after sealing', () => {
    const pluginState = createPluginStateMap();

    publishPluginState(pluginState, 'catalog', { ready: true });
    expect(pluginState.get('catalog')).toEqual({ ready: true });

    sealPluginState(pluginState);
    expect(isPluginStateSealed(pluginState)).toBe(true);
    expect(pluginState.get('catalog')).toEqual({ ready: true });
    expect(() => publishPluginState(pluginState, 'late', true)).toThrow(
      'pluginState is sealed after app bootstrap',
    );
    expect(() => (pluginState as Map<string, unknown>).set('late', true)).toThrow(
      'pluginState is sealed after app bootstrap',
    );
    expect(() => (pluginState as Map<string, unknown>).delete('catalog')).toThrow(
      'pluginState is sealed after app bootstrap',
    );
    expect(() => (pluginState as Map<string, unknown>).clear()).toThrow(
      'pluginState is sealed after app bootstrap',
    );
  });
});

describe('getPluginStateFromRequestOrNull', () => {
  test('returns null when slingshotCtx not set', () => {
    const c = { get: () => null };
    expect(getPluginStateFromRequestOrNull(c)).toBeNull();
  });

  test('returns pluginState from slingshotCtx on request', () => {
    const map = new Map();
    const c = { get: (key: string) => (key === 'slingshotCtx' ? { pluginState: map } : null) };
    expect(getPluginStateFromRequestOrNull(c)).toBe(map);
  });
});

describe('getPluginStateFromRequest', () => {
  test('throws when pluginState not available on request', () => {
    const c = { get: () => null };
    expect(() => getPluginStateFromRequest(c)).toThrow(
      'pluginState is not available on this request',
    );
  });

  test('returns pluginState from request context', () => {
    const map = new Map();
    const c = { get: (key: string) => (key === 'slingshotCtx' ? { pluginState: map } : null) };
    expect(getPluginStateFromRequest(c)).toBe(map);
  });
});

describe('entity adapter plugin state', () => {
  test('publishEntityAdaptersState creates a frozen plugin-owned state object', () => {
    const pluginState = new Map<string, unknown>();
    const adapter = { list: () => Promise.resolve([]) };

    const state = publishEntityAdaptersState(pluginState, 'catalog', {
      Retailer: adapter,
    });

    expect(state).toEqual({
      entityAdapters: {
        Retailer: adapter,
      },
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.entityAdapters!)).toBe(true);
    expect(pluginState.get('catalog')).toBe(state);
  });

  test('publishEntityAdaptersState preserves top-level keys and merges adapters by entity name', () => {
    const adapter = { list: () => Promise.resolve([]) };
    const pluginState = new Map<string, unknown>([
      [
        'catalog',
        Object.freeze({
          interactionsPeer: { refresh: () => Promise.resolve() },
          entityAdapters: Object.freeze({
            Retailer: adapter,
          }),
        }),
      ],
    ]);

    const nextState = publishEntityAdaptersState(pluginState, 'catalog', {
      Retailer: adapter,
      Category: { list: () => Promise.resolve([]) },
    });

    expect(Object.isFrozen(nextState)).toBe(true);
    expect(Object.isFrozen(nextState.entityAdapters!)).toBe(true);
    expect(nextState).toMatchObject({
      interactionsPeer: { refresh: expect.any(Function) },
      entityAdapters: {
        Retailer: adapter,
        Category: expect.any(Object),
      },
    });
  });

  test('publishEntityAdaptersState rejects non-mergeable plugin state', () => {
    const pluginState = new Map<string, unknown>([['catalog', 'not-an-object']]);

    expect(() =>
      publishEntityAdaptersState(pluginState, 'catalog', {
        Retailer: { list: () => Promise.resolve([]) },
      }),
    ).toThrow("pluginState['catalog'] is not mergeable");
  });

  test('publishEntityAdaptersState rejects duplicate entity publication with a different instance', () => {
    const pluginState = new Map<string, unknown>();

    publishEntityAdaptersState(pluginState, 'catalog', {
      Retailer: { list: () => Promise.resolve([]) },
    });

    expect(() =>
      publishEntityAdaptersState(pluginState, 'catalog', {
        Retailer: { list: () => Promise.resolve([]) },
      }),
    ).toThrow("Entity adapter 'Retailer' for plugin 'catalog' was already published");
  });

  test('maybeEntityAdapter and requireEntityAdapter resolve adapters from attached app context', () => {
    const app = {};
    const pluginState = new Map<string, unknown>();
    const adapter = { list: () => Promise.resolve([]) };

    attachContext(app, { pluginState } as never);
    publishEntityAdaptersState(pluginState, 'catalog', {
      Retailer: adapter,
    });

    expect(maybeEntityAdapter(app, { plugin: 'catalog', entity: 'Retailer' })).toBe(adapter);
    expect(requireEntityAdapter(app, { plugin: 'catalog', entity: 'Retailer' })).toBe(adapter);
  });

  test('requireEntityAdapter throws a clear error when the adapter is missing', () => {
    const pluginState = new Map<string, unknown>();

    expect(() =>
      requireEntityAdapter(pluginState, { plugin: 'catalog', entity: 'Retailer' }),
    ).toThrow("Entity adapter 'Retailer' from plugin 'catalog' is not available");
  });
});
