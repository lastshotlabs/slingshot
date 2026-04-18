import type { GroupResolver } from '@lastshotlabs/slingshot-core';

type AuthLikeRuntime = {
  adapter?: {
    getUserGroups?: (
      userId: string,
      tenantId: string | null,
    ) => Promise<Array<{ group: { id: string } }>>;
  };
};

/**
 * Creates a `GroupResolver` backed by a Slingshot auth runtime when one is available.
 *
 * The returned resolver is lazy: it reads the current runtime on each call so it can be
 * created before the auth plugin has populated `pluginState`. When auth is unavailable or
 * the adapter does not implement group lookups, the resolver returns an empty set.
 *
 * @param getRuntime - Callback returning the current auth-like runtime.
 * @returns A `GroupResolver` that derives group IDs from `adapter.getUserGroups()`.
 */
export function createAuthGroupResolver(
  getRuntime: () => AuthLikeRuntime | null | undefined,
): GroupResolver {
  return {
    async getGroupsForUser(userId: string, tenantId: string | null): Promise<string[]> {
      const runtime = getRuntime();
      const getUserGroups = runtime?.adapter?.getUserGroups;
      if (!getUserGroups) return [];
      const groups = await getUserGroups(userId, tenantId);
      return Array.from(
        new Set(
          groups
            .map(entry => entry.group.id)
            .filter(
              (groupId): groupId is string => typeof groupId === 'string' && groupId.length > 0,
            ),
        ),
      );
    },
  };
}
