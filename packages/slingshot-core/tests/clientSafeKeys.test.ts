import { beforeEach, describe, expect, test } from 'bun:test';
import { BUILTIN_CLIENT_SAFE_KEYS, InProcessAdapter } from '../src/eventBus';
import type { SlingshotEventBus } from '../src/eventBus';

let bus: SlingshotEventBus;

beforeEach(() => {
  bus = new InProcessAdapter();
});

describe('clientSafeKeys (instance-scoped)', () => {
  test('every built-in key is a non-empty string', () => {
    for (const key of bus.clientSafeKeys) {
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    }
  });

  test('contains known built-in keys', () => {
    expect(bus.clientSafeKeys.has('community:thread.created')).toBe(true);
    expect(bus.clientSafeKeys.has('community:reply.created')).toBe(true);
  });

  test('community:content.reported is NOT in clientSafeKeys (reporterId privacy)', () => {
    expect(bus.clientSafeKeys.has('community:content.reported')).toBe(false);
  });

  test('no forbidden namespace keys (security., auth:, community:delivery., app:)', () => {
    for (const key of bus.clientSafeKeys) {
      expect(key.startsWith('security.')).toBe(false);
      expect(key.startsWith('auth:')).toBe(false);
      expect(key.startsWith('community:delivery.')).toBe(false);
      expect(key.startsWith('app:')).toBe(false);
    }
  });

  test('each bus instance gets its own copy of built-in keys', () => {
    const bus2 = new InProcessAdapter();
    bus.registerClientSafeEvents(['custom:only.on.bus1']);
    expect(bus.clientSafeKeys.has('custom:only.on.bus1')).toBe(true);
    expect(bus2.clientSafeKeys.has('custom:only.on.bus1')).toBe(false);
  });

  test('exposes a runtime-readonly set view', () => {
    const view = bus.clientSafeKeys as object;
    expect('add' in view).toBe(false);
    expect('delete' in view).toBe(false);
    expect('clear' in view).toBe(false);
  });
});

describe('bus.registerClientSafeEvents', () => {
  test('adds new keys to the instance set', () => {
    const before = bus.clientSafeKeys.size;
    bus.registerClientSafeEvents(['custom:event.one', 'custom:event.two']);
    expect(bus.clientSafeKeys.has('custom:event.one')).toBe(true);
    expect(bus.clientSafeKeys.has('custom:event.two')).toBe(true);
    expect(bus.clientSafeKeys.size).toBe(before + 2);
  });

  test('rejects security.* keys', () => {
    expect(() => bus.registerClientSafeEvents(['security.login.failed'])).toThrow(
      'Cannot register "security.login.failed" as client-safe: "security." namespace is forbidden',
    );
  });

  test('rejects auth:* keys', () => {
    expect(() => bus.registerClientSafeEvents(['auth:session.created'])).toThrow(
      '"auth:" namespace is forbidden',
    );
  });

  test('rejects community:delivery.* keys', () => {
    expect(() => bus.registerClientSafeEvents(['community:delivery.email.sent'])).toThrow(
      '"community:delivery." namespace is forbidden',
    );
  });

  test('rejects app:* keys', () => {
    expect(() => bus.registerClientSafeEvents(['app:server.started'])).toThrow(
      '"app:" namespace is forbidden',
    );
  });

  test('fail-fast: valid keys before invalid one are still added', () => {
    expect(() => bus.registerClientSafeEvents(['custom:valid.key.xyz', 'security.bad'])).toThrow();
    expect(bus.clientSafeKeys.has('custom:valid.key.xyz')).toBe(true);
  });

  test('is idempotent for existing keys', () => {
    const before = bus.clientSafeKeys.size;
    bus.registerClientSafeEvents(['community:thread.created']);
    expect(bus.clientSafeKeys.size).toBe(before);
  });
});

describe('bus.ensureClientSafeEventKey', () => {
  test('accepts built-in client-safe event keys', () => {
    expect(bus.ensureClientSafeEventKey('community:thread.created')).toBe(
      'community:thread.created',
    );
  });

  test('rejects forbidden namespaces', () => {
    expect(() =>
      bus.ensureClientSafeEventKey('security.auth.login.success', 'sse.endpoints["/feed"].events'),
    ).toThrow('"security." namespace is forbidden');
  });

  test('rejects unregistered custom keys', () => {
    expect(() =>
      bus.ensureClientSafeEventKey('custom:event.missing', 'sse.endpoints["/feed"].events'),
    ).toThrow('is not registered as client-safe');
  });

  test('accepts registered custom keys', () => {
    bus.registerClientSafeEvents(['custom:event.registered']);
    expect(bus.ensureClientSafeEventKey('custom:event.registered')).toBe('custom:event.registered');
  });
});

describe('BUILTIN_CLIENT_SAFE_KEYS', () => {
  test('is frozen (immutable seed data)', () => {
    expect(Object.isFrozen(BUILTIN_CLIENT_SAFE_KEYS)).toBe(true);
  });

  test('does not expose mutating Set methods at runtime', () => {
    const view = BUILTIN_CLIENT_SAFE_KEYS as object;
    expect('add' in view).toBe(false);
    expect('delete' in view).toBe(false);
    expect('clear' in view).toBe(false);
  });

  test('matches the default keys on a fresh bus instance', () => {
    for (const key of BUILTIN_CLIENT_SAFE_KEYS) {
      expect(bus.clientSafeKeys.has(key)).toBe(true);
    }
    expect(bus.clientSafeKeys.size).toBe(BUILTIN_CLIENT_SAFE_KEYS.size);
  });
});
