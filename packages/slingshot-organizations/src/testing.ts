// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-organizations/testing — Test utilities
// ---------------------------------------------------------------------------

import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { createOrganizationsPlugin } from './plugin';
import type { OrganizationsPluginOptions } from './plugin';

export function createTestOrganizationsPlugin(
  opts?: Partial<OrganizationsPluginOptions>,
): SlingshotPlugin {
  return createOrganizationsPlugin({
    adapter: 'memory' as const,
    ...opts,
  } as OrganizationsPluginOptions);
}

export type { OrganizationsPluginOptions } from './plugin';
export { SlugConflictError, isUniqueViolationError } from './errors';
