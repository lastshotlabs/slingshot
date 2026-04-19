import { describe, expect, test } from 'bun:test';
import { getEmbedsPeer, getEmbedsPeerOrNull } from '../../src/embedsPeer';
import { EMBEDS_PLUGIN_STATE_KEY } from '../../src/pluginKeys';

describe('getEmbedsPeerOrNull', () => {
  test('returns null for null input', () => {
    expect(getEmbedsPeerOrNull(null)).toBeNull();
  });

  test('returns null for undefined input', () => {
    expect(getEmbedsPeerOrNull(undefined)).toBeNull();
  });

  test('returns null when pluginState has no embeds key', () => {
    const map = new Map();
    expect(getEmbedsPeerOrNull(map)).toBeNull();
  });

  test('returns null when embeds state has no unfurl function', () => {
    const map = new Map();
    map.set(EMBEDS_PLUGIN_STATE_KEY, { notUnfurl: true });
    expect(getEmbedsPeerOrNull(map)).toBeNull();
  });

  test('returns null when embeds state is null', () => {
    const map = new Map();
    map.set(EMBEDS_PLUGIN_STATE_KEY, null);
    expect(getEmbedsPeerOrNull(map)).toBeNull();
  });

  test('returns the peer when unfurl is a function', () => {
    const peer = { unfurl: async (_urls: string[]) => [] };
    const map = new Map();
    map.set(EMBEDS_PLUGIN_STATE_KEY, peer);
    expect(getEmbedsPeerOrNull(map)).toBe(peer);
  });

  test('returns peer from carrier with pluginState', () => {
    const peer = { unfurl: async (_urls: string[]) => [] };
    const map = new Map();
    map.set(EMBEDS_PLUGIN_STATE_KEY, peer);
    const carrier = { pluginState: map };
    expect(getEmbedsPeerOrNull(carrier)).toBe(peer);
  });
});

describe('getEmbedsPeer', () => {
  test('throws when embeds peer is not available', () => {
    const map = new Map();
    expect(() => getEmbedsPeer(map)).toThrow(
      '[slingshot-embeds] embeds peer is not available in pluginState',
    );
  });

  test('throws for null input', () => {
    expect(() => getEmbedsPeer(null)).toThrow(
      '[slingshot-embeds] embeds peer is not available in pluginState',
    );
  });

  test('returns the peer when available', () => {
    const peer = { unfurl: async (_urls: string[]) => [] };
    const map = new Map();
    map.set(EMBEDS_PLUGIN_STATE_KEY, peer);
    const result = getEmbedsPeer(map);
    expect(result).toBe(peer);
  });
});
