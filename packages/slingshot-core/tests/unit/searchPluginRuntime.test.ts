import { describe, expect, test } from 'bun:test';
import {
  SEARCH_PLUGIN_STATE_KEY,
  getSearchPluginRuntime,
  getSearchPluginRuntimeOrNull,
} from '../../src/searchPluginRuntime';

describe('getSearchPluginRuntimeOrNull', () => {
  test('returns null for null input', () => {
    expect(getSearchPluginRuntimeOrNull(null)).toBeNull();
  });

  test('returns null when no search entry', () => {
    const map = new Map();
    expect(getSearchPluginRuntimeOrNull(map)).toBeNull();
  });

  test('returns null when entry is not an object', () => {
    const map = new Map([[SEARCH_PLUGIN_STATE_KEY, 'string']]);
    expect(getSearchPluginRuntimeOrNull(map)).toBeNull();
  });

  test('returns null when missing required methods', () => {
    const map = new Map([[SEARCH_PLUGIN_STATE_KEY, { ensureConfigEntity: () => {} }]]);
    expect(getSearchPluginRuntimeOrNull(map)).toBeNull();
  });

  test('returns null when ensureConfigEntity is not a function', () => {
    const map = new Map([
      [SEARCH_PLUGIN_STATE_KEY, { ensureConfigEntity: 'not-fn', getSearchClient: () => {} }],
    ]);
    expect(getSearchPluginRuntimeOrNull(map)).toBeNull();
  });

  test('returns runtime when both methods present', () => {
    const runtime = {
      ensureConfigEntity: async () => {},
      getSearchClient: () => null,
    };
    const map = new Map([[SEARCH_PLUGIN_STATE_KEY, runtime]]);
    expect(getSearchPluginRuntimeOrNull(map)).toBe(runtime);
  });
});

describe('getSearchPluginRuntime', () => {
  test('throws when not available', () => {
    expect(() => getSearchPluginRuntime(null)).toThrow('search runtime is not available');
  });

  test('returns runtime when available', () => {
    const runtime = {
      ensureConfigEntity: async () => {},
      getSearchClient: () => null,
    };
    const map = new Map([[SEARCH_PLUGIN_STATE_KEY, runtime]]);
    expect(getSearchPluginRuntime(map)).toBe(runtime);
  });
});
