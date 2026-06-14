/**
 * Public contract for `slingshot-organizations`.
 *
 * Cross-package consumers resolve `OrganizationsOrgServiceCap` through `ctx.capabilities.require(...)`.
 * The legacy `getOrganizationsOrgService(...)` helper is retained as a thin wrapper that
 * resolves through the same contract path.
 */
import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { OrganizationsOrgService } from './orgService';

/** Provider-owned package contract for `slingshot-organizations`. */
export const Organizations = definePackageContract('slingshot-organizations');

/**
 * Capability handle for the organizations org service.
 *
 * Cross-package consumers resolve it through `ctx.capabilities.require(OrganizationsOrgServiceCap)`
 * to look up org membership, create orgs, and manage org-scoped state.
 */
export const OrganizationsOrgServiceCap =
  Organizations.capability<OrganizationsOrgService>('orgService');
