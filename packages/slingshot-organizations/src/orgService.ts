import type { PluginStateCarrier, PluginStateMap } from '@lastshotlabs/slingshot-core';
import { getPluginStateOrNull } from '@lastshotlabs/slingshot-core';
// Note: `OrgServiceCap` lives in ./public; the helpers below resolve through the
// PACKAGE_CAPABILITIES_PREFIX slot directly to avoid a static cycle (public.ts
// imports from this file).

/**
 * Runtime organization service published through plugin state.
 *
 * Peer plugins use this contract to resolve organizations by slug, create
 * organizations, and add members without depending on a concrete adapter.
 */
export type OrganizationsOrgService = {
  /**
   * Look up an organization by slug, optionally scoped to a tenant.
   *
   * In multi-tenant deployments two tenants may legitimately reuse the same
   * slug, so callers must pass the resolved `tenantId` to disambiguate.
   * Omitting `tenantId` matches a global (untenanted) organization only.
   *
   * @returns The org's `id` when a unique match is found, otherwise `null`.
   */
  getOrgBySlug(slug: string, tenantId?: string): Promise<{ id: string } | null>;
  createOrg(data: {
    name: string;
    slug: string;
    tenantId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }>;
  addOrgMember(
    orgId: string,
    userId: string,
    roles?: string[],
    invitedBy?: string,
  ): Promise<unknown>;
};

function isOrganizationsOrgService(value: unknown): value is OrganizationsOrgService {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'getOrgBySlug') === 'function' &&
    typeof Reflect.get(value, 'createOrg') === 'function' &&
    typeof Reflect.get(value, 'addOrgMember') === 'function'
  );
}

/**
 * Retrieve the {@link OrganizationsOrgService} from plugin state, throwing if it
 * is not available. Use this when the organizations plugin is a required dependency
 * and its absence is a configuration error.
 */
export function getOrganizationsOrgService(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): OrganizationsOrgService {
  const service = getOrganizationsOrgServiceOrNull(input);
  if (!service) {
    throw new Error(
      '[slingshot-organizations] organizations org service is not available in pluginState',
    );
  }
  return service;
}

/**
 * Retrieve the {@link OrganizationsOrgService} from plugin state, returning `null`
 * when the organizations plugin has not been registered or has not yet completed
 * its `setupPost` lifecycle phase.
 */
export function getOrganizationsOrgServiceOrNull(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): OrganizationsOrgService | null {
  const pluginState = getPluginStateOrNull(input);
  if (!pluginState) return null;

  // Contract resolution: read the capability slot the plugin writes via
  // `registerPluginCapabilities`. New consumers should prefer
  // `ctx.capabilities.require(OrgServiceCap)` for typed access.
  const slot = pluginState.get('slingshot:package:capabilities:slingshot-organizations') as
    | { orgService?: OrganizationsOrgService }
    | undefined;
  if (slot?.orgService && isOrganizationsOrgService(slot.orgService)) {
    return slot.orgService;
  }
  return null;
}
