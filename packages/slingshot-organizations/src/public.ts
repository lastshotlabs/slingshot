/**
 * Public contract for `slingshot-organizations`.
 *
 * Cross-package consumers resolve `OrgServiceCap` through `ctx.capabilities.require(...)`.
 * The legacy `getOrganizationsOrgService(...)` helper is retained as a thin wrapper that
 * resolves through the same contract path.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { OrganizationsOrgService } from './orgService';

export const Organizations = definePackageContract('slingshot-organizations');

export const OrgServiceCap = Organizations.capability<OrganizationsOrgService>('orgService');
