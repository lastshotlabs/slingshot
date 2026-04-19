import { describe, expect, test } from 'bun:test';
import {
  getAuthRuntimePeer,
  getAuthRuntimePeerOrNull,
  AUTH_PLUGIN_STATE_KEY,
} from '../../src/authPeer';

describe('getAuthRuntimePeerOrNull', () => {
  test('returns null for null input', () => {
    expect(getAuthRuntimePeerOrNull(null)).toBeNull();
  });

  test('returns null when no auth state entry', () => {
    const map = new Map();
    expect(getAuthRuntimePeerOrNull(map)).toBeNull();
  });

  test('returns null when entry is not an object', () => {
    const map = new Map([[AUTH_PLUGIN_STATE_KEY, 'not-object']]);
    expect(getAuthRuntimePeerOrNull(map)).toBeNull();
  });

  test('returns null when adapter is not an object', () => {
    const map = new Map([[AUTH_PLUGIN_STATE_KEY, { adapter: 'string' }]]);
    expect(getAuthRuntimePeerOrNull(map)).toBeNull();
  });

  test('returns null when adapter is null', () => {
    const map = new Map([[AUTH_PLUGIN_STATE_KEY, { adapter: null }]]);
    expect(getAuthRuntimePeerOrNull(map)).toBeNull();
  });

  test('returns peer when adapter is valid object', () => {
    const runtime = { adapter: { findUser: () => {} }, config: { primaryField: 'email' } };
    const map = new Map([[AUTH_PLUGIN_STATE_KEY, runtime]]);
    expect(getAuthRuntimePeerOrNull(map)).toBe(runtime);
  });
});

describe('getAuthRuntimePeer', () => {
  test('throws when not available', () => {
    expect(() => getAuthRuntimePeer(null)).toThrow('auth runtime peer is not available');
  });

  test('returns peer when available', () => {
    const runtime = { adapter: { findUser: () => {} } };
    const map = new Map([[AUTH_PLUGIN_STATE_KEY, runtime]]);
    expect(getAuthRuntimePeer(map)).toBe(runtime);
  });
});
