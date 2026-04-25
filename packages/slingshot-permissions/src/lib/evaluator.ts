import type {
  EvaluationScope,
  GroupResolver,
  PermissionEvaluator,
  PermissionGrant,
  PermissionRegistry,
  PermissionsAdapter,
  SubjectRef,
} from '@lastshotlabs/slingshot-core';
import { SUPER_ADMIN_ROLE } from '@lastshotlabs/slingshot-core';

interface EvaluatorConfig {
  registry: PermissionRegistry;
  adapter: PermissionsAdapter;
  groupResolver?: GroupResolver;
  /**
   * Maximum number of groups to expand per `can()` call for a user.
   *
   * When a user belongs to more groups than this limit, the excess groups are silently
   * ignored and a console.warn is emitted. Defaults to 50.
   *
   * Set this to a value appropriate for your group model. A low limit protects against
   * pathological N+1 amplification; a high limit supports deep org hierarchies.
   */
  maxGroups?: number;
}

function grantMatchesScope(grant: PermissionGrant, scope?: EvaluationScope): boolean {
  // Global grant - always applies.
  if (grant.tenantId === null && grant.resourceType === null && grant.resourceId === null) {
    return true;
  }

  const tenantId = scope?.tenantId;
  if (tenantId === undefined || grant.tenantId !== tenantId) {
    return false;
  }

  // Tenant-wide grant.
  if (grant.resourceType === null && grant.resourceId === null) {
    return true;
  }

  const resourceType = scope?.resourceType;
  if (resourceType === undefined || grant.resourceType !== resourceType) {
    return false;
  }

  // Resource-type-wide grant.
  if (grant.resourceId === null) {
    return true;
  }

  const resourceId = scope?.resourceId;
  return resourceId !== undefined && grant.resourceId === resourceId;
}

/**
 * Creates a `PermissionEvaluator` that resolves whether a subject can perform an action.
 *
 * The evaluator implements a deny-wins cascade model:
 * 1. Collect all active grants for the subject (and their groups if `groupResolver` is set).
 * 2. Apply scope matching — global → tenant → resource-type → specific resource.
 * 3. If any deny grant covers the action, return `false` immediately.
 * 4. If any allow grant covers the action, return `true`.
 * 5. Default-deny: return `false`.
 *
 * @param config - Registry, adapter, and optional group resolver.
 * @returns A `PermissionEvaluator` with a single `can()` method.
 *
 * @example
 * ```ts
 * import {
 *   createPermissionRegistry,
 *   createMemoryPermissionsAdapter,
 *   createPermissionEvaluator,
 * } from '@lastshotlabs/slingshot-permissions';
 *
 * const registry = createPermissionRegistry();
 * registry.register({ resourceType: 'posts', roles: { editor: ['read', 'write'] } });
 *
 * const adapter = createMemoryPermissionsAdapter();
 * const evaluator = createPermissionEvaluator({ registry, adapter });
 *
 * const allowed = await evaluator.can(
 *   { subjectId: 'user-1', subjectType: 'user' },
 *   'write',
 *   { tenantId: 'tenant-1', resourceType: 'posts' },
 * );
 * ```
 */
export function createPermissionEvaluator(config: EvaluatorConfig): PermissionEvaluator {
  const { registry, adapter, groupResolver } = config;
  const maxGroups = config.maxGroups ?? 50;

  async function collectGrantsForSubject(
    subject: SubjectRef,
    scope?: EvaluationScope,
  ): Promise<PermissionGrant[]> {
    return adapter.getEffectiveGrantsForSubject(subject.subjectId, subject.subjectType, scope);
  }

  return {
    async can(subject: SubjectRef, action: string, scope?: EvaluationScope): Promise<boolean> {
      // Collect grants for the subject
      let grants = await collectGrantsForSubject(subject, scope);

      // Group expansion for users — fetch all groups concurrently
      if (subject.subjectType === 'user' && groupResolver) {
        const tenantId = scope?.tenantId ?? null;
        const allGroupIds = await groupResolver.getGroupsForUser(subject.subjectId, tenantId);
        const groupIds =
          allGroupIds.length > maxGroups ? allGroupIds.slice(0, maxGroups) : allGroupIds;
        if (allGroupIds.length > maxGroups) {
          console.warn(
            `[slingshot-permissions] evaluator.can() truncated group expansion for user '${subject.subjectId}' ` +
              `from ${allGroupIds.length} to ${maxGroups} groups. ` +
              `Increase maxGroups in createPermissionEvaluator() config if needed.`,
          );
        }
        if (groupIds.length > 0) {
          const groupGrantArrays = await Promise.all(
            groupIds.map(groupId =>
              collectGrantsForSubject({ subjectId: groupId, subjectType: 'group' }, scope),
            ),
          );
          for (const groupGrants of groupGrantArrays) {
            grants = grants.concat(groupGrants);
          }
        }
      }

      // Safety net: adapters already filter revoked/expired at query level,
      // but we guard here in case a caller passes grants from an external source.
      const now = new Date();
      const activeGrants = grants.filter(g => {
        if (g.revokedAt) return false;
        if (g.expiresAt && g.expiresAt < now) return false;
        if (!grantMatchesScope(g, scope)) return false;
        return true;
      });

      const resourceType = scope?.resourceType ?? '';

      if (!resourceType && activeGrants.length > 0) {
        console.warn(
          `[slingshot-permissions] evaluator.can('${action}') called without scope.resourceType — ` +
            "registry lookup uses '' which matches no registered type. " +
            "Add scope: { resourceType: 'your-type' } to the permission config or can() call.",
        );
      }

      // Separate allow and deny grants
      const denyGrants = activeGrants.filter(g => g.effect === 'deny');
      const allowGrants = activeGrants.filter(g => g.effect === 'allow');

      // Super-admin early exit — evaluated before deny so it cannot be blocked.
      // Super-admin is the system's ultimate authority; deny grants apply only to
      // named roles, not to the super-admin principal itself.
      for (const grant of allowGrants) {
        if (grant.roles.includes(SUPER_ADMIN_ROLE)) return true;
      }

      // CRITICAL: deny always wins for all non-super-admin roles
      for (const grant of denyGrants) {
        for (const role of grant.roles) {
          const actions = registry.getActionsForRole(resourceType, role);
          if (actions.includes('*') || actions.includes(action)) {
            return false;
          }
        }
      }

      // Check allow grants
      for (const grant of allowGrants) {
        for (const role of grant.roles) {
          const actions = registry.getActionsForRole(resourceType, role);
          if (actions.includes('*') || actions.includes(action)) {
            return true;
          }
        }
      }

      return false;
    },
  };
}
