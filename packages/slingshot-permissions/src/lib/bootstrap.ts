import type { PermissionsAdapter, SubjectType } from '@lastshotlabs/slingshot-core';
import { SUPER_ADMIN_ROLE } from '@lastshotlabs/slingshot-core';

/**
 * Seeds a super-admin grant for the given subject using the `SUPER_ADMIN_ROLE`.
 *
 * The grant is global (no tenant, no resource) so it applies everywhere. Typically called
 * once during application bootstrap or database seeding for the initial admin account.
 *
 * @param adapter - Any `PermissionsAdapter` to persist the grant.
 * @param opts - Subject ID, optional type (defaults to `'user'`), and audit `grantedBy` string.
 * @returns The newly created grant ID.
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
  return adapter.createGrant({
    subjectId: opts.subjectId,
    subjectType: opts.subjectType ?? 'user',
    tenantId: null,
    resourceType: null,
    resourceId: null,
    roles: [SUPER_ADMIN_ROLE],
    effect: 'allow',
    grantedBy: opts.grantedBy ?? 'bootstrap',
  });
}
