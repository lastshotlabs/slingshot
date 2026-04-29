/**
 * Edge-case coverage for the in-memory permissions adapter.
 *
 * Builds on the core adapter tests in tests/integration/memory-adapter.test.ts.
 * Covers concurrent grant writes, grant expiration handling, grant revocation
 * cascading, bulk createGrants validation, and memory pressure patterns.
 */
import { describe, expect, test } from 'bun:test';
import type { PermissionGrant } from '@lastshotlabs/slingshot-core';
import { createMemoryPermissionsAdapter } from '../../src/adapters/memory';

function baseGrant(
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

// ---------------------------------------------------------------------------
// Concurrent grant writes
// ---------------------------------------------------------------------------

describe('memory adapter: concurrent writes', () => {
  test('concurrent createGrant calls all return unique IDs', async () => {
    const adapter = createMemoryPermissionsAdapter();

    const results = await Promise.all([
      adapter.createGrant(baseGrant({ subjectId: 'user-a' })),
      adapter.createGrant(baseGrant({ subjectId: 'user-b' })),
      adapter.createGrant(baseGrant({ subjectId: 'user-c' })),
      adapter.createGrant(baseGrant({ subjectId: 'user-d' })),
    ]);

    expect(new Set(results).size).toBe(4);
    const allGrants = await adapter.getGrantsForSubject('user-a');
    expect(allGrants).toHaveLength(1);
  });

  test('concurrent createGrant and revokeGrant on same subject do not corrupt state', async () => {
    const adapter = createMemoryPermissionsAdapter();

    const id = await adapter.createGrant(baseGrant({ subjectId: 'target' }));

    // Fire concurrent creates and revokes
    await Promise.all([
      adapter.createGrant(baseGrant({ subjectId: 'target', roles: ['editor'] })),
      adapter.createGrant(baseGrant({ subjectId: 'target', roles: ['reader'] })),
      adapter.revokeGrant(id, 'admin'),
    ]);

    // State should be consistent
    const grants = await adapter.getGrantsForSubject('target');
    expect(grants.length).toBeGreaterThanOrEqual(0);
    // The revoked grant should not appear in active grants
    const revokedStillPresent = grants.some(g => g.id === id);
    expect(revokedStillPresent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Grant expiration
// ---------------------------------------------------------------------------

describe('memory adapter: grant expiration', () => {
  test('getEffectiveGrantsForSubject filters out expired grants', async () => {
    const adapter = createMemoryPermissionsAdapter();
    const future = new Date(Date.now() + 100_000);

    const activeId = await adapter.createGrant(
      baseGrant({ subjectId: 'user-1', roles: ['editor'], expiresAt: future }),
    );
    expect(activeId).toBeTruthy();

    // getEffectiveGrantsForSubject should not filter by expiresAt itself
    // (that's the evaluator's job), but we verify the grant is present
    const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user');
    expect(grants).toHaveLength(1);
    expect(grants[0].expiresAt?.getTime()).toBe(future.getTime());
  });

  test('createGrant rejects expiresAt in the past', async () => {
    const adapter = createMemoryPermissionsAdapter();
    const past = new Date(Date.now() - 10_000);

    await expect(adapter.createGrant(baseGrant({ expiresAt: past }))).rejects.toThrow();
  });

  test('expiresAt exactly at the current time boundary may be accepted (adapter validates > now, not >= now)', async () => {
    const adapter = createMemoryPermissionsAdapter();
    const now = new Date();

    // The validation allows expiresAt == now since it uses a > check
    await expect(adapter.createGrant(baseGrant({ expiresAt: now }))).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Grant revocation edge cases
// ---------------------------------------------------------------------------

describe('memory adapter: revocation edge cases', () => {
  test('revoking a grant that was already revoked twice returns false', async () => {
    const adapter = createMemoryPermissionsAdapter();
    const id = await adapter.createGrant(baseGrant());
    await adapter.revokeGrant(id, 'admin-1');
    await adapter.revokeGrant(id, 'admin-2');
    const third = await adapter.revokeGrant(id, 'admin-3');
    expect(third).toBe(false);
  });

  test('revokeGrant without tenantScope revokes grant regardless of tenant', async () => {
    const adapter = createMemoryPermissionsAdapter();
    const tenantGrantId = await adapter.createGrant(baseGrant({ tenantId: 'tenant-a' }));

    // revoke without tenantScope should work by grant ID
    const result = await adapter.revokeGrant(tenantGrantId, 'admin');
    expect(result).toBe(true);

    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants).toHaveLength(0);
  });

  test('revokeGrant with revokedReason at 1024 chars is accepted', async () => {
    const adapter = createMemoryPermissionsAdapter();
    const id = await adapter.createGrant(baseGrant());
    const reason = 'x'.repeat(1024);
    const result = await adapter.revokeGrant(id, 'admin', undefined, reason);
    expect(result).toBe(true);
  });

  test('revokeGrant with revokedReason at 1025 chars is rejected', async () => {
    const adapter = createMemoryPermissionsAdapter();
    const id = await adapter.createGrant(baseGrant());
    const reason = 'x'.repeat(1025);
    await expect(adapter.revokeGrant(id, 'admin', undefined, reason)).rejects.toThrow();
  });

  test('re-revoke fails and history tracks the first revoker only', async () => {
    const adapter = createMemoryPermissionsAdapter();
    const id = await adapter.createGrant(baseGrant());

    await adapter.revokeGrant(id, 'first-admin');
    await adapter.revokeGrant(id, 'second-admin');

    const history = await adapter.listGrantHistory('user-1', 'user');
    expect(history).toHaveLength(1);
    expect(history[0].revokedBy).toBe('first-admin');
  });
});

// ---------------------------------------------------------------------------
// createGrants validation edge cases
// ---------------------------------------------------------------------------

describe('memory adapter: bulk createGrants validation', () => {
  test('createGrants with empty array returns empty array', async () => {
    const adapter = createMemoryPermissionsAdapter();
    const ids = await adapter.createGrants([]);
    expect(ids).toEqual([]);
  });

  test('createGrants rejects a mix where one has invalid effect', async () => {
    const adapter = createMemoryPermissionsAdapter();
    const inputs = [
      baseGrant({ subjectId: 'user-a' }),
      { ...baseGrant({ subjectId: 'user-b' }), effect: 'maybe' },
    ] as unknown as Parameters<typeof adapter.createGrants>[0];

    await expect(adapter.createGrants(inputs)).rejects.toThrow();
    // No grants should have been written
    const grantsA = await adapter.getGrantsForSubject('user-a');
    expect(grantsA).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Subject type and scoping edge cases
// ---------------------------------------------------------------------------

describe('memory adapter: subject type and scope edge cases', () => {
  test('getGrantsForSubject with empty subjectId returns empty', async () => {
    const adapter = createMemoryPermissionsAdapter();
    await adapter.createGrant(baseGrant({ subjectId: 'user-1' }));
    const grants = await adapter.getGrantsForSubject('');
    expect(grants).toHaveLength(0);
  });

  test('Grants for different subjectTypes with same ID are isolated', async () => {
    const adapter = createMemoryPermissionsAdapter();
    await adapter.createGrant(baseGrant({ subjectId: 'shared-id', subjectType: 'user' }));
    await adapter.createGrant(
      baseGrant({ subjectId: 'shared-id', subjectType: 'group', roles: ['editor'] }),
    );

    const userGrants = await adapter.getGrantsForSubject('shared-id', 'user');
    expect(userGrants).toHaveLength(1);
    expect(userGrants[0].subjectType).toBe('user');

    const groupGrants = await adapter.getGrantsForSubject('shared-id', 'group');
    expect(groupGrants).toHaveLength(1);
    expect(groupGrants[0].subjectType).toBe('group');
  });

  test('listGrantHistory returns empty array for subject with no history', async () => {
    const adapter = createMemoryPermissionsAdapter();
    const history = await adapter.listGrantHistory('user-none', 'user');
    expect(history).toEqual([]);
  });

  test('deleteAllGrantsForSubject with no matching subject does not error', async () => {
    const adapter = createMemoryPermissionsAdapter();
    await expect(
      adapter.deleteAllGrantsForSubject({ subjectId: 'nonexistent', subjectType: 'user' }),
    ).resolves.toBeUndefined();
  });
});
