// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-organizations/testing — Test utilities
// ---------------------------------------------------------------------------
import type { SlingshotPackageDefinition } from '@lastshotlabs/slingshot-core';
import { createOrganizationsPackage } from './plugin';
import type { OrganizationsPluginConfig, OrganizationsPluginDeps } from './plugin';

export function createTestOrganizationsPackage(
  opts?: Partial<OrganizationsPluginConfig>,
  deps?: OrganizationsPluginDeps,
): SlingshotPackageDefinition {
  return createOrganizationsPackage(opts, deps);
}

export type { OrganizationsPluginConfig, OrganizationsPluginDeps } from './plugin';
export { SlugConflictError, isUniqueViolationError } from './errors';
