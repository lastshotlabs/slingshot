import type { PermissionsAdapter, SubjectType } from '@lastshotlabs/slingshot-core';
import { SUPER_ADMIN_ROLE } from '@lastshotlabs/slingshot-core';

/**
 * Seeds a super-admin grant for the given subject using the `SUPER_ADMIN_ROLE`.
 *
 * The grant is global (no tenant, no resource) so it applies everywhere. This function
 * is idempotent — if the subject already holds an active super-admin grant it returns
 * that grant's ID without creating a duplicate. Safe to call on every deployment.
 *
 * @param adapter - Any `PermissionsAdapter` to persist the grant.
 * @param opts - Subject ID, optional type (defaults to `'user'`), and audit `grantedBy` string.
 * @returns The grant ID (existing or newly created).
 *
 * @example
 * ```ts
 * import { seedSuperAdmin, createMemoryPermissionsAdapter } from '@lastshotlabs/slingshot-permissions';
 *
 * const adapter = createMemoryPermissionsAdapter();
 * const grantId = await seedSuperAdmin(adapter, {
 *   subjectId: 'user-abc123',
 *   grantedBy: 'bootstrap',
 * });
 * ```
 */
export async function seedSuperAdmin(
  adapter: PermissionsAdapter,
  opts: { subjectId: string; subjectType?: SubjectType; grantedBy?: string },
): Promise<string> {
  const subjectType = opts.subjectType ?? 'user';
  const existing = await adapter.getGrantsForSubject(opts.subjectId, subjectType, {
    tenantId: null,
    resourceType: null,
    resourceId: null,
  });
  const active = existing.find(
    g => g.roles.includes(SUPER_ADMIN_ROLE) && g.effect === 'allow' && !g.revokedAt,
  );
  if (active) return active.id;

  return adapter.createGrant({
    subjectId: opts.subjectId,
    subjectType,
    tenantId: null,
    resourceType: null,
    resourceId: null,
    roles: [SUPER_ADMIN_ROLE],
    effect: 'allow',
    grantedBy: opts.grantedBy ?? 'bootstrap',
  });
}
