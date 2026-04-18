import { describe, expect, test } from 'bun:test';
import { validateGrant } from '@lastshotlabs/slingshot-core';
import type { PermissionGrant } from '@lastshotlabs/slingshot-core';

function validGrant(
  overrides?: Partial<Omit<PermissionGrant, 'id' | 'grantedAt'>>,
): Omit<PermissionGrant, 'id' | 'grantedAt'> {
  return {
    subjectId: 'user-1',
    subjectType: 'user',
    tenantId: null,
    resourceType: null,
    resourceId: null,
    roles: ['admin'],
    effect: 'allow',
    grantedBy: 'system',
    ...overrides,
  };
}

describe('validateGrant', () => {
  test('valid grant passes without throwing', () => {
    expect(() => validateGrant(validGrant())).not.toThrow();
  });

  test('resourceId non-null with resourceType null throws', () => {
    expect(() => validateGrant(validGrant({ resourceId: 'res-1', resourceType: null }))).toThrow(
      'resourceId requires resourceType to be set',
    );
  });

  test('resourceId non-null with resourceType set passes', () => {
    expect(() =>
      validateGrant(validGrant({ resourceId: 'res-1', resourceType: 'post' })),
    ).not.toThrow();
  });

  test('empty roles array throws', () => {
    expect(() => validateGrant(validGrant({ roles: [] }))).toThrow(
      'grant must have at least one role',
    );
  });

  test('invalid effect throws', () => {
    // @ts-expect-error — intentionally passing invalid effect to test runtime validation
    expect(() => validateGrant(validGrant({ effect: 'maybe' }))).toThrow(
      "effect must be 'allow' or 'deny'",
    );
  });

  test("effect 'deny' is valid", () => {
    expect(() => validateGrant(validGrant({ effect: 'deny' }))).not.toThrow();
  });

  test('expiresAt not a Date throws', () => {
    // @ts-expect-error — intentionally passing a string where Date is required
    expect(() => validateGrant(validGrant({ expiresAt: '2030-01-01' }))).toThrow(
      'expiresAt must be a Date object',
    );
  });

  test('expiresAt in the past throws', () => {
    const past = new Date(Date.now() - 10_000);
    expect(() => validateGrant(validGrant({ expiresAt: past }))).toThrow(
      'expiresAt must be in the future',
    );
  });

  test('expiresAt in the future is valid', () => {
    const future = new Date(Date.now() + 100_000);
    expect(() => validateGrant(validGrant({ expiresAt: future }))).not.toThrow();
  });

  test('invalid subjectType throws', () => {
    // @ts-expect-error — intentionally passing invalid subjectType to test runtime validation
    expect(() => validateGrant(validGrant({ subjectType: 'robot' }))).toThrow(
      'invalid subjectType',
    );
  });

  test("subjectType 'group' is valid", () => {
    expect(() => validateGrant(validGrant({ subjectType: 'group' }))).not.toThrow();
  });

  test("subjectType 'service-account' is valid", () => {
    expect(() => validateGrant(validGrant({ subjectType: 'service-account' }))).not.toThrow();
  });
});
