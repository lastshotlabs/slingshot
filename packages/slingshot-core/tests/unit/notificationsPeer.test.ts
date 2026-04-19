import { describe, expect, test } from 'bun:test';
import {
  NOTIFICATIONS_PLUGIN_STATE_KEY,
  getNotificationsState,
  getNotificationsStateOrNull,
} from '../../src/notificationsPeer';

function makeFakePeerState() {
  return {
    createBuilder: () => ({
      notify: async () => null,
      notifyMany: async () => [],
      schedule: async () => ({}),
      cancel: async () => {},
    }),
    registerDeliveryAdapter: () => {},
  };
}

describe('NOTIFICATIONS_PLUGIN_STATE_KEY', () => {
  test('is the string "slingshot-notifications"', () => {
    expect(NOTIFICATIONS_PLUGIN_STATE_KEY).toBe('slingshot-notifications');
  });
});

describe('getNotificationsStateOrNull', () => {
  test('returns null for null input', () => {
    expect(getNotificationsStateOrNull(null)).toBeNull();
  });

  test('returns null for undefined input', () => {
    expect(getNotificationsStateOrNull(undefined)).toBeNull();
  });

  test('returns null when pluginState has no notifications key', () => {
    const map = new Map();
    expect(getNotificationsStateOrNull(map)).toBeNull();
  });

  test('returns null when notifications state is null', () => {
    const map = new Map();
    map.set(NOTIFICATIONS_PLUGIN_STATE_KEY, null);
    expect(getNotificationsStateOrNull(map)).toBeNull();
  });

  test('returns null when notifications state is undefined', () => {
    const map = new Map();
    map.set(NOTIFICATIONS_PLUGIN_STATE_KEY, undefined);
    expect(getNotificationsStateOrNull(map)).toBeNull();
  });

  test('returns null when createBuilder is missing', () => {
    const map = new Map();
    map.set(NOTIFICATIONS_PLUGIN_STATE_KEY, {
      registerDeliveryAdapter: () => {},
    });
    expect(getNotificationsStateOrNull(map)).toBeNull();
  });

  test('returns null when registerDeliveryAdapter is missing', () => {
    const map = new Map();
    map.set(NOTIFICATIONS_PLUGIN_STATE_KEY, {
      createBuilder: () => ({}),
    });
    expect(getNotificationsStateOrNull(map)).toBeNull();
  });

  test('returns null when createBuilder is not a function', () => {
    const map = new Map();
    map.set(NOTIFICATIONS_PLUGIN_STATE_KEY, {
      createBuilder: 'not-a-function',
      registerDeliveryAdapter: () => {},
    });
    expect(getNotificationsStateOrNull(map)).toBeNull();
  });

  test('returns null when registerDeliveryAdapter is not a function', () => {
    const map = new Map();
    map.set(NOTIFICATIONS_PLUGIN_STATE_KEY, {
      createBuilder: () => ({}),
      registerDeliveryAdapter: 42,
    });
    expect(getNotificationsStateOrNull(map)).toBeNull();
  });

  test('returns the peer state when both methods are functions', () => {
    const peer = makeFakePeerState();
    const map = new Map();
    map.set(NOTIFICATIONS_PLUGIN_STATE_KEY, peer);
    expect(getNotificationsStateOrNull(map)).toBe(peer);
  });

  test('returns peer state from carrier with pluginState', () => {
    const peer = makeFakePeerState();
    const map = new Map();
    map.set(NOTIFICATIONS_PLUGIN_STATE_KEY, peer);
    const carrier = { pluginState: map };
    expect(getNotificationsStateOrNull(carrier)).toBe(peer);
  });
});

describe('getNotificationsState', () => {
  test('throws when notifications peer state is not available', () => {
    const map = new Map();
    expect(() => getNotificationsState(map)).toThrow(
      '[slingshot-notifications] notifications peer state is not available in pluginState',
    );
  });

  test('throws for null input', () => {
    expect(() => getNotificationsState(null)).toThrow(
      '[slingshot-notifications] notifications peer state is not available in pluginState',
    );
  });

  test('throws for undefined input', () => {
    expect(() => getNotificationsState(undefined)).toThrow(
      '[slingshot-notifications] notifications peer state is not available in pluginState',
    );
  });

  test('throws when only one method is present', () => {
    const map = new Map();
    map.set(NOTIFICATIONS_PLUGIN_STATE_KEY, { createBuilder: () => ({}) });
    expect(() => getNotificationsState(map)).toThrow(
      '[slingshot-notifications] notifications peer state is not available in pluginState',
    );
  });

  test('returns the peer state when available', () => {
    const peer = makeFakePeerState();
    const map = new Map();
    map.set(NOTIFICATIONS_PLUGIN_STATE_KEY, peer);
    const result = getNotificationsState(map);
    expect(result).toBe(peer);
  });

  test('returns peer state from carrier', () => {
    const peer = makeFakePeerState();
    const map = new Map();
    map.set(NOTIFICATIONS_PLUGIN_STATE_KEY, peer);
    const carrier = { pluginState: map };
    const result = getNotificationsState(carrier);
    expect(result).toBe(peer);
  });
});
