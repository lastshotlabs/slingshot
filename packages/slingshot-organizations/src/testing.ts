// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-organizations/testing — Test utilities
// ---------------------------------------------------------------------------
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { createOrganizationsPlugin } from './plugin';
import type { OrganizationsPluginConfig, OrganizationsPluginDeps } from './plugin';

export function createTestOrganizationsPlugin(
  opts?: Partial<OrganizationsPluginConfig>,
  deps?: OrganizationsPluginDeps,
): SlingshotPlugin {
  return createOrganizationsPlugin(opts, deps);
}

export type { OrganizationsPluginConfig, OrganizationsPluginDeps } from './plugin';
export { SlugConflictError, isUniqueViolationError } from './errors';
