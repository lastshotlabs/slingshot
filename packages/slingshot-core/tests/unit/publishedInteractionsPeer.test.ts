import { describe, expect, test } from 'bun:test';
import { getPublishedInteractionsPeerOrNull } from '../../src/publishedInteractionsPeer';

describe('getPublishedInteractionsPeerOrNull', () => {
  test('returns null when input is null', () => {
    expect(getPublishedInteractionsPeerOrNull(null, 'my-plugin')).toBeNull();
  });

  test('returns null when input is undefined', () => {
    expect(getPublishedInteractionsPeerOrNull(undefined, 'my-plugin')).toBeNull();
  });

  test('returns null when plugin state has no entry for the key', () => {
    const pluginState = new Map();
    expect(getPublishedInteractionsPeerOrNull(pluginState, 'missing-key')).toBeNull();
  });

  test('returns null when interactionsPeer is missing on state', () => {
    const pluginState = new Map([['my-plugin', { foo: 'bar' }]]);
    expect(getPublishedInteractionsPeerOrNull(pluginState, 'my-plugin')).toBeNull();
  });

  test('returns null when interactionsPeer is not a valid peer (missing methods)', () => {
    const pluginState = new Map([['my-plugin', { interactionsPeer: { notAPeer: true } }]]);
    expect(getPublishedInteractionsPeerOrNull(pluginState, 'my-plugin')).toBeNull();
  });

  test('returns null when interactionsPeer is null', () => {
    const pluginState = new Map([['my-plugin', { interactionsPeer: null }]]);
    expect(getPublishedInteractionsPeerOrNull(pluginState, 'my-plugin')).toBeNull();
  });

  test('returns peer when valid peer with both methods exists', () => {
    const peer = {
      resolveMessageByKindAndId: async () => null,
      updateComponents: async () => {},
    };
    const pluginState = new Map([['my-plugin', { interactionsPeer: peer }]]);
    const result = getPublishedInteractionsPeerOrNull(pluginState, 'my-plugin');
    expect(result).toBe(peer);
  });

  test('accepts PluginStateCarrier input', () => {
    const peer = {
      resolveMessageByKindAndId: async () => null,
      updateComponents: async () => {},
    };
    const carrier = { pluginState: new Map([['my-plugin', { interactionsPeer: peer }]]) };
    const result = getPublishedInteractionsPeerOrNull(carrier, 'my-plugin');
    expect(result).toBe(peer);
  });
});
