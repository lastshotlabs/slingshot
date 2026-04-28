import { describe, expect, test } from 'bun:test';
import {
  PERMISSIONS_STATE_KEY,
  SUPER_ADMIN_ROLE,
  getPermissionsState,
  getPermissionsStateOrNull,
  validateGrant,
} from '../../src/permissions';

const baseGrant = (overrides: Partial<Parameters<typeof validateGrant>[0]> = {}) => ({
  subjectId: 'user-1',
  subjectType: 'user' as const,
  tenantId: null,
  resourceType: null,
  resourceId: null,
  roles: ['reader'],
  effect: 'allow' as const,
  grantedBy: 'system',
  ...overrides,
});

describe('validateGrant', () => {
  test('valid grant passes without error', () => {
    expect(() => validateGrant(baseGrant())).not.toThrow();
  });

  test('resourceId without resourceType throws', () => {
    expect(() => validateGrant(baseGrant({ resourceId: 'p1', resourceType: null }))).toThrow(
      'resourceId requires resourceType',
    );
  });

  test('empty roles throws', () => {
    expect(() => validateGrant(baseGrant({ roles: [] }))).toThrow('at least one role');
  });

  test('invalid effect throws', () => {
    expect(() => validateGrant(baseGrant({ effect: 'maybe' as never }))).toThrow(
      "effect must be 'allow' or 'deny'",
    );
  });

  test('non-Date expiresAt throws', () => {
    expect(() => validateGrant(baseGrant({ expiresAt: '2024-01-01' as never }))).toThrow(
      'expiresAt must be a Date',
    );
  });

  test('past expiresAt throws', () => {
    expect(() => validateGrant(baseGrant({ expiresAt: new Date(Date.now() - 100000) }))).toThrow(
      'expiresAt must be in the future',
    );
  });

  test('invalid subjectType throws', () => {
    expect(() => validateGrant(baseGrant({ subjectType: 'robot' as never }))).toThrow(
      'invalid subjectType',
    );
  });

  test('service-account subjectType is valid', () => {
    expect(() => validateGrant(baseGrant({ subjectType: 'service-account' }))).not.toThrow();
  });

  test('group subjectType is valid', () => {
    expect(() => validateGrant(baseGrant({ subjectType: 'group' }))).not.toThrow();
  });

  // Length limits
  test('subjectId exceeding max length throws', () => {
    expect(() => validateGrant(baseGrant({ subjectId: 'x'.repeat(300) }))).toThrow(
      'subjectId exceeds maximum length',
    );
  });

  test('grantedBy exceeding max length throws', () => {
    expect(() => validateGrant(baseGrant({ grantedBy: 'x'.repeat(300) }))).toThrow(
      'grantedBy exceeds maximum length',
    );
  });

  test('reason exceeding max length throws', () => {
    expect(() => validateGrant(baseGrant({ reason: 'x'.repeat(2000) }))).toThrow(
      'reason exceeds maximum length',
    );
  });

  test('resourceType exceeding max length throws', () => {
    expect(() => validateGrant(baseGrant({ resourceType: 'x'.repeat(300) }))).toThrow(
      'resourceType exceeds maximum length',
    );
  });

  test('resourceId exceeding max length throws', () => {
    expect(() =>
      validateGrant(baseGrant({ resourceType: 'post', resourceId: 'x'.repeat(300) })),
    ).toThrow('resourceId exceeds maximum length');
  });

  test('tenantId exceeding max length throws', () => {
    expect(() => validateGrant(baseGrant({ tenantId: 'x'.repeat(300) }))).toThrow(
      'tenantId exceeds maximum length',
    );
  });

  test('too many roles throws', () => {
    const roles = Array.from({ length: 60 }, (_, i) => `role-${i}`);
    expect(() => validateGrant(baseGrant({ roles }))).toThrow('roles array exceeds maximum length');
  });

  test('role name exceeding max length throws', () => {
    expect(() => validateGrant(baseGrant({ roles: ['x'.repeat(300)] }))).toThrow(
      'role exceeds maximum length',
    );
  });

  test('valid grant with future expiresAt passes', () => {
    expect(() =>
      validateGrant(baseGrant({ expiresAt: new Date(Date.now() + 100000) })),
    ).not.toThrow();
  });
});

describe('getPermissionsStateOrNull', () => {
  test('returns null for null input', () => {
    expect(getPermissionsStateOrNull(null)).toBeNull();
  });

  test('returns null when no permissions state entry', () => {
    const map = new Map();
    expect(getPermissionsStateOrNull(map)).toBeNull();
  });

  test('returns null when state is incomplete (missing adapter)', () => {
    const map = new Map([[PERMISSIONS_STATE_KEY, { registry: {}, evaluator: {} }]]);
    expect(getPermissionsStateOrNull(map)).toBeNull();
  });

  test('returns state when all fields present', () => {
    const state = {
      adapter: { createGrant: () => {} },
      registry: { register: () => {} },
      evaluator: { can: async () => true },
    };
    const map = new Map([[PERMISSIONS_STATE_KEY, state]]);
    expect(getPermissionsStateOrNull(map)).toBe(state as never);
  });
});

describe('getPermissionsState', () => {
  test('throws when state not available', () => {
    expect(() => getPermissionsState(null)).toThrow('permissions state is not available');
  });

  test('returns state when available', () => {
    const state = {
      adapter: { createGrant: () => {} },
      registry: { register: () => {} },
      evaluator: { can: async () => true },
    };
    const map = new Map([[PERMISSIONS_STATE_KEY, state]]);
    expect(getPermissionsState(map)).toBe(state as never);
  });
});

describe('constants', () => {
  test('SUPER_ADMIN_ROLE is super-admin', () => {
    expect(SUPER_ADMIN_ROLE).toBe('super-admin');
  });
});
