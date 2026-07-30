import { describe, expect, test } from 'bun:test';
import { createEventVersionRegistry } from '../../src/eventVersionRegistry';

describe('event version registry', () => {
  test('adapts through one unique ascending chain', () => {
    const registry = createEventVersionRegistry();
    registry.register({
      eventKey: 'orders:created',
      fromVersion: 1,
      toVersion: 2,
      adapt: payload => ({ ...(payload as object), currency: 'USD' }),
    });
    registry.register({
      eventKey: 'orders:created',
      fromVersion: 2,
      toVersion: 3,
      adapt: payload => ({ ...(payload as object), source: 'replay' }),
    });

    expect(registry.adapt('orders:created', 1, 3, { total: 10 })).toEqual({
      payload: { total: 10, currency: 'USD', source: 'replay' },
      storedVersion: 1,
      currentVersion: 3,
      adapted: true,
    });
  });

  test('rejects duplicate, skipped, downgrade, future, and missing paths', () => {
    const registry = createEventVersionRegistry();
    registry.register({
      eventKey: 'orders:created',
      fromVersion: 1,
      toVersion: 2,
      adapt: payload => payload,
    });

    expect(() =>
      registry.register({
        eventKey: 'orders:created',
        fromVersion: 1,
        toVersion: 2,
        adapt: payload => payload,
      }),
    ).toThrow('already registered');
    expect(() =>
      registry.register({
        eventKey: 'orders:created',
        fromVersion: 2,
        toVersion: 4,
        adapt: payload => payload,
      }),
    ).toThrow('exactly one version');
    expect(() => registry.adapt('orders:created', 3, 2, {})).toThrow('newer than current');
    expect(() => registry.adapt('orders:created', 1, 3, {})).toThrow(
      'Missing "orders:created" adapter from version 2 to 3',
    );
  });

  test('freezes registration while preserving adaptation', () => {
    const registry = createEventVersionRegistry();
    registry.register({
      eventKey: 'orders:created',
      fromVersion: 1,
      toVersion: 2,
      adapt: payload => payload,
    });
    registry.freeze();

    expect(registry.frozen).toBe(true);
    expect(registry.adapt('orders:created', 1, 2, 'payload').payload).toBe('payload');
    expect(() =>
      registry.register({
        eventKey: 'orders:created',
        fromVersion: 2,
        toVersion: 3,
        adapt: payload => payload,
      }),
    ).toThrow('after freeze');
  });
});
