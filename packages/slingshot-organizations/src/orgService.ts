import type { PluginStateCarrier, PluginStateMap } from '@lastshotlabs/slingshot-core';
import { getPluginStateOrNull } from '@lastshotlabs/slingshot-core';

export type OrganizationsOrgService = {
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

export function getOrganizationsOrgServiceOrNull(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): OrganizationsOrgService | null {
  const pluginState = getPluginStateOrNull(input);
  const service = pluginState?.get(ORGANIZATIONS_ORG_SERVICE_STATE_KEY);
  return isOrganizationsOrgService(service) ? service : null;
}
