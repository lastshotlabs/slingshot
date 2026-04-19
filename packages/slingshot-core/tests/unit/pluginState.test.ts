import { describe, expect, test } from 'bun:test';
import {
  resolvePluginState,
  getPluginStateOrNull,
  getPluginState,
  getPluginStateFromRequestOrNull,
  getPluginStateFromRequest,
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
    expect(() => getPluginStateFromRequest(c)).toThrow('pluginState is not available on this request');
  });

  test('returns pluginState from request context', () => {
    const map = new Map();
    const c = { get: (key: string) => (key === 'slingshotCtx' ? { pluginState: map } : null) };
    expect(getPluginStateFromRequest(c)).toBe(map);
  });
});
