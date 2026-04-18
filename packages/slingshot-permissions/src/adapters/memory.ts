import { DEFAULT_MAX_ENTRIES, evictOldestArray, validateGrant } from '@lastshotlabs/slingshot-core';
import type {
  EvaluationScope,
  PermissionGrant,
  SubjectRef,
  SubjectType,
  TestablePermissionsAdapter,
} from '@lastshotlabs/slingshot-core';

/**
 * Alias for `TestablePermissionsAdapter` returned by `createMemoryPermissionsAdapter`.
 * Exposes the `clear()` method for resetting state between tests.
 */
export type PermissionsMemoryAdapter = TestablePermissionsAdapter;

function resolveSync<T>(operation: () => T): Promise<T> {
  return Promise.resolve().then(operation);
}

/**
 * Creates an in-memory `PermissionsAdapter` for development and testing.
 *
 * Grants are stored in a plain array; no external dependencies required.
 * All query methods respect active-only filtering (revoked and expired grants excluded).
 * Scope cascade (global -> tenant -> resource-type -> resource) is applied in memory.
 *
 * @param options - Optional capacity limit (`maxEntries`). Defaults to `DEFAULT_MAX_ENTRIES`.
 * @returns A `PermissionsMemoryAdapter` instance with an extra `clear()` method for test teardown.
 *
 * @remarks
 * Prints a startup warning to `console.warn`. Not suitable for production - all data is lost
 * on process restart.
 *
 * @example
 * ```ts
 * import { createMemoryPermissionsAdapter } from '@lastshotlabs/slingshot-permissions/testing';
 *
 * const adapter = createMemoryPermissionsAdapter();
 * afterEach(() => adapter.clear());
 * ```
 */
export function createMemoryPermissionsAdapter(options?: {
  maxEntries?: number;
}): PermissionsMemoryAdapter {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  console.warn('[slingshot] Memory permissions adapter is for development/testing only');

  const grants: PermissionGrant[] = [];

  return {
    createGrant(grant: Omit<PermissionGrant, 'id' | 'grantedAt'>): Promise<string> {
      return resolveSync(() => {
        validateGrant(grant);
        const id = crypto.randomUUID();
        const fullGrant: PermissionGrant = {
          ...grant,
          id,
          grantedAt: new Date(),
        };
        evictOldestArray(grants, maxEntries);
        grants.push(fullGrant);
        return id;
      });
    },

    revokeGrant(grantId: string, revokedBy: string, tenantScope?: string): Promise<boolean> {
      return resolveSync(() => {
        const grant = grants.find(g => g.id === grantId);
        if (!grant || grant.revokedAt) return false;
        if (tenantScope !== undefined && grant.tenantId !== tenantScope) return false;
        grant.revokedBy = revokedBy;
        grant.revokedAt = new Date();
        return true;
      });
    },

    getGrantsForSubject(
      subjectId: string,
      subjectType?: SubjectType,
      scope?: Partial<Pick<PermissionGrant, 'tenantId' | 'resourceType' | 'resourceId'>>,
    ): Promise<PermissionGrant[]> {
      return resolveSync(() => {
        const now = new Date();
        return grants.filter(g => {
          if (g.subjectId !== subjectId) return false;
          if (subjectType !== undefined && g.subjectType !== subjectType) return false;
          if (g.revokedAt) return false;
          if (g.expiresAt && g.expiresAt < now) return false;
          if (scope !== undefined) {
            if (scope.tenantId !== undefined && g.tenantId !== scope.tenantId) return false;
            if (scope.resourceType !== undefined && g.resourceType !== scope.resourceType) {
              return false;
            }
            if (scope.resourceId !== undefined && g.resourceId !== scope.resourceId) return false;
          }
          return true;
        });
      });
    },

    listGrantHistory(subjectId: string, subjectType: SubjectType): Promise<PermissionGrant[]> {
      return resolveSync(() =>
        grants.filter(g => g.subjectId === subjectId && g.subjectType === subjectType),
      );
    },

    getEffectiveGrantsForSubject(
      subjectId: string,
      subjectType: SubjectType,
      scope?: EvaluationScope,
    ): Promise<PermissionGrant[]> {
      return resolveSync(() => {
        const now = new Date();
        const tenantId = scope?.tenantId;
        const resourceType = scope?.resourceType ?? null;
        const resourceId = scope?.resourceId ?? null;
        return grants.filter(g => {
          if (g.subjectId !== subjectId || g.subjectType !== subjectType) return false;
          if (g.revokedAt) return false;
          if (g.expiresAt && g.expiresAt < now) return false;
          // Global grant (level 4) - always applicable
          if (g.tenantId === null && g.resourceType === null && g.resourceId === null) return true;
          if (tenantId === undefined) return false;
          if (g.tenantId !== tenantId) return false;
          // Tenant-wide (level 3)
          if (g.resourceType === null && g.resourceId === null) return true;
          if (resourceType === null) return false;
          if (g.resourceType !== resourceType) return false;
          // Resource-type-wide (level 2)
          if (g.resourceId === null) return true;
          // Specific resource (level 1)
          return resourceId !== null && g.resourceId === resourceId;
        });
      });
    },

    listGrantsOnResource(
      resourceType: string,
      resourceId: string,
      tenantId?: string | null,
    ): Promise<PermissionGrant[]> {
      return resolveSync(() => {
        const now = new Date();
        return grants.filter(g => {
          if (g.resourceType !== resourceType) return false;
          if (g.resourceId !== resourceId) return false;
          if (g.revokedAt) return false;
          if (tenantId !== undefined && g.tenantId !== tenantId) return false;
          if (g.expiresAt && g.expiresAt < now) return false;
          return true;
        });
      });
    },

    deleteAllGrantsForSubject(subject: SubjectRef): Promise<void> {
      return resolveSync(() => {
        const toRemove = grants.filter(
          g => g.subjectId === subject.subjectId && g.subjectType === subject.subjectType,
        );
        for (const grant of toRemove) {
          const idx = grants.indexOf(grant);
          if (idx !== -1) grants.splice(idx, 1);
        }
      });
    },

    clear(): Promise<void> {
      return resolveSync(() => {
        grants.length = 0;
      });
    },
  };
}
