import { describe, expect, test } from 'bun:test';
import { getPushFormatterPeer, getPushFormatterPeerOrNull } from '../../src/pushPeer';
import { PUSH_PLUGIN_STATE_KEY } from '../../src/pluginKeys';

describe('getPushFormatterPeerOrNull', () => {
  test('returns null for null input', () => {
    expect(getPushFormatterPeerOrNull(null)).toBeNull();
  });

  test('returns null for undefined input', () => {
    expect(getPushFormatterPeerOrNull(undefined)).toBeNull();
  });

  test('returns null when pluginState has no push key', () => {
    const map = new Map();
    expect(getPushFormatterPeerOrNull(map)).toBeNull();
  });

  test('returns null when push state has no registerFormatter function', () => {
    const map = new Map();
    map.set(PUSH_PLUGIN_STATE_KEY, { notRegisterFormatter: true });
    expect(getPushFormatterPeerOrNull(map)).toBeNull();
  });

  test('returns null when push state is null', () => {
    const map = new Map();
    map.set(PUSH_PLUGIN_STATE_KEY, null);
    expect(getPushFormatterPeerOrNull(map)).toBeNull();
  });

  test('returns null when push state is undefined', () => {
    const map = new Map();
    map.set(PUSH_PLUGIN_STATE_KEY, undefined);
    expect(getPushFormatterPeerOrNull(map)).toBeNull();
  });

  test('returns the peer when registerFormatter is a function', () => {
    const peer = { registerFormatter: () => {} };
    const map = new Map();
    map.set(PUSH_PLUGIN_STATE_KEY, peer);
    expect(getPushFormatterPeerOrNull(map)).toBe(peer);
  });

  test('returns peer from carrier with pluginState', () => {
    const peer = { registerFormatter: () => {} };
    const map = new Map();
    map.set(PUSH_PLUGIN_STATE_KEY, peer);
    const carrier = { pluginState: map };
    expect(getPushFormatterPeerOrNull(carrier)).toBe(peer);
  });
});

describe('getPushFormatterPeer', () => {
  test('throws when push formatter peer is not available', () => {
    const map = new Map();
    expect(() => getPushFormatterPeer(map)).toThrow(
      '[slingshot-push] push formatter peer is not available in pluginState',
    );
  });

  test('throws for null input', () => {
    expect(() => getPushFormatterPeer(null)).toThrow(
      '[slingshot-push] push formatter peer is not available in pluginState',
    );
  });

  test('throws for undefined input', () => {
    expect(() => getPushFormatterPeer(undefined)).toThrow(
      '[slingshot-push] push formatter peer is not available in pluginState',
    );
  });

  test('returns the peer when available', () => {
    const peer = { registerFormatter: () => {} };
    const map = new Map();
    map.set(PUSH_PLUGIN_STATE_KEY, peer);
    const result = getPushFormatterPeer(map);
    expect(result).toBe(peer);
  });

  test('returns peer from carrier', () => {
    const peer = { registerFormatter: () => {} };
    const map = new Map();
    map.set(PUSH_PLUGIN_STATE_KEY, peer);
    const carrier = { pluginState: map };
    const result = getPushFormatterPeer(carrier);
    expect(result).toBe(peer);
  });
});
