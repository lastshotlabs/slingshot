import type { PluginStateCarrier, PluginStateMap } from '@lastshotlabs/slingshot-core';
import { getPluginStateOrNull } from '@lastshotlabs/slingshot-core';

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

/**
 * Plugin-state key used to store and retrieve the {@link OrganizationsOrgService}
 * instance from the shared Slingshot plugin state map.
 */
export const ORGANIZATIONS_ORG_SERVICE_STATE_KEY = 'slingshot-organizations.orgService' as const;

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
  const service = pluginState?.get(ORGANIZATIONS_ORG_SERVICE_STATE_KEY);
  return isOrganizationsOrgService(service) ? service : null;
}
