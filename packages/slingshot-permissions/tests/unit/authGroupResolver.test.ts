import { describe, expect, test } from 'bun:test';
import { createAuthGroupResolver } from '../../src/lib/authGroupResolver';

describe('createAuthGroupResolver', () => {
  test('returns empty array when runtime is null', async () => {
    const resolver = createAuthGroupResolver(() => null);
    const groups = await resolver.getGroupsForUser('user-1', null);
    expect(groups).toEqual([]);
  });

  test('returns empty array when runtime is undefined', async () => {
    const resolver = createAuthGroupResolver(() => undefined);
    const groups = await resolver.getGroupsForUser('user-1', null);
    expect(groups).toEqual([]);
  });

  test('returns empty array when runtime has no adapter', async () => {
    const resolver = createAuthGroupResolver(() => ({}));
    const groups = await resolver.getGroupsForUser('user-1', null);
    expect(groups).toEqual([]);
  });

  test('returns empty array when adapter has no getUserGroups method', async () => {
    const resolver = createAuthGroupResolver(() => ({ adapter: {} }));
    const groups = await resolver.getGroupsForUser('user-1', null);
    expect(groups).toEqual([]);
  });

  test('returns empty array when getUserGroups returns empty array', async () => {
    const resolver = createAuthGroupResolver(() => ({
      adapter: { getUserGroups: async () => [] },
    }));
    const groups = await resolver.getGroupsForUser('user-1', null);
    expect(groups).toEqual([]);
  });

  test('returns group IDs for the given user', async () => {
    const resolver = createAuthGroupResolver(() => ({
      adapter: {
        getUserGroups: async (userId: string) =>
          userId === 'user-1' ? [{ group: { id: 'group-a' } }, { group: { id: 'group-b' } }] : [],
      },
    }));
    const groups = await resolver.getGroupsForUser('user-1', null);
    expect(groups).toEqual(['group-a', 'group-b']);
  });

  test('passes tenantId to getUserGroups', async () => {
    let capturedTenantId: string | null | undefined;
    const resolver = createAuthGroupResolver(() => ({
      adapter: {
        getUserGroups: async (_userId: string, tenantId: string | null) => {
          capturedTenantId = tenantId;
          return [];
        },
      },
    }));
    await resolver.getGroupsForUser('user-1', 'tenant-x');
    expect(capturedTenantId).toBe('tenant-x');
  });

  test('deduplicates group IDs returned by getUserGroups', async () => {
    const resolver = createAuthGroupResolver(() => ({
      adapter: {
        getUserGroups: async () => [
          { group: { id: 'group-a' } },
          { group: { id: 'group-b' } },
          { group: { id: 'group-a' } }, // duplicate
        ],
      },
    }));
    const groups = await resolver.getGroupsForUser('user-1', null);
    expect(groups).toHaveLength(2);
    expect(new Set(groups).size).toBe(2);
    expect(groups).toContain('group-a');
    expect(groups).toContain('group-b');
  });

  test('filters out empty string group IDs', async () => {
    const resolver = createAuthGroupResolver(() => ({
      adapter: {
        getUserGroups: async () => [
          { group: { id: 'group-a' } },
          { group: { id: '' } }, // empty — should be filtered
          { group: { id: 'group-b' } },
        ],
      },
    }));
    const groups = await resolver.getGroupsForUser('user-1', null);
    expect(groups).toEqual(['group-a', 'group-b']);
  });

  test('filters out non-string group IDs', async () => {
    const resolver = createAuthGroupResolver(() => ({
      adapter: {
        // @ts-expect-error intentionally passing invalid data to test runtime filtering
        getUserGroups: async () => [
          { group: { id: 'group-a' } },
          { group: { id: 42 } }, // number — should be filtered
          { group: { id: null } }, // null — should be filtered
        ],
      },
    }));
    const groups = await resolver.getGroupsForUser('user-1', null);
    expect(groups).toEqual(['group-a']);
  });

  test('re-reads runtime on every call (lazy resolution)', async () => {
    let currentRuntime: {
      adapter: {
        getUserGroups: (
          userId: string,
          tenantId: string | null,
        ) => Promise<Array<{ group: { id: string } }>>;
      };
    } | null = null;
    const resolver = createAuthGroupResolver(() => currentRuntime);

    // Before runtime is available — returns empty
    const beforeRuntime = await resolver.getGroupsForUser('user-1', null);
    expect(beforeRuntime).toEqual([]);

    // After runtime becomes available
    currentRuntime = {
      adapter: { getUserGroups: async () => [{ group: { id: 'group-late' } }] },
    };
    const afterRuntime = await resolver.getGroupsForUser('user-1', null);
    expect(afterRuntime).toEqual(['group-late']);
  });
});
