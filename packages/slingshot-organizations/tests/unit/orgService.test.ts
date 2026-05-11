import { describe, expect, test } from 'bun:test';
import {
  getOrganizationsOrgService,
  getOrganizationsOrgServiceOrNull,
} from '../../src/orgService';

// The orgService helpers read the capability slot written by
// `registerPluginCapabilities(..., 'slingshot-organizations', ...)`. Tests
// publish the service directly under this slot.
const ORGANIZATIONS_ORG_SERVICE_STATE_KEY =
  'slingshot:package:capabilities:slingshot-organizations';

function makeValidService() {
  return {
    getOrgBySlug: async () => null,
    createOrg: async () => ({ id: 'org-1' }),
    addOrgMember: async () => undefined,
  };
}

function makePluginState(key: string, value: unknown) {
  // The orgService capability slot stores `{ orgService }`; store under that
  // shape when the test targets the capability key, and pass raw values through
  // when the test stores under an unrelated key.
  const slot = key === ORGANIZATIONS_ORG_SERVICE_STATE_KEY ? { orgService: value } : value;
  return { pluginState: new Map([[key, slot]]) };
}

describe('getOrganizationsOrgServiceOrNull', () => {
  test('returns null when input is null', () => {
    expect(getOrganizationsOrgServiceOrNull(null)).toBeNull();
  });

  test('returns null when input is undefined', () => {
    expect(getOrganizationsOrgServiceOrNull(undefined)).toBeNull();
  });

  test('returns null when pluginState has no org service entry', () => {
    const state = makePluginState('some.other.key', {});
    expect(getOrganizationsOrgServiceOrNull(state)).toBeNull();
  });

  test('returns null when org service entry lacks required methods', () => {
    const partial = { getOrgBySlug: async () => null };
    const state = makePluginState(ORGANIZATIONS_ORG_SERVICE_STATE_KEY, partial);
    expect(getOrganizationsOrgServiceOrNull(state)).toBeNull();
  });

  test('returns null when org service entry is not an object', () => {
    const state = makePluginState(ORGANIZATIONS_ORG_SERVICE_STATE_KEY, 'not-an-object');
    expect(getOrganizationsOrgServiceOrNull(state)).toBeNull();
  });

  test('returns the service when all required methods are present', () => {
    const service = makeValidService();
    const state = makePluginState(ORGANIZATIONS_ORG_SERVICE_STATE_KEY, service);
    expect(getOrganizationsOrgServiceOrNull(state)).toBe(service);
  });
});

describe('getOrganizationsOrgService', () => {
  test('returns the service when available', () => {
    const service = makeValidService();
    const state = makePluginState(ORGANIZATIONS_ORG_SERVICE_STATE_KEY, service);
    expect(getOrganizationsOrgService(state)).toBe(service);
  });

  test('throws when service is not available', () => {
    expect(() => getOrganizationsOrgService(null)).toThrow(
      '[slingshot-organizations] organizations org service is not available',
    );
  });

  test('throws when pluginState entry is missing required methods', () => {
    const state = makePluginState(ORGANIZATIONS_ORG_SERVICE_STATE_KEY, {});
    expect(() => getOrganizationsOrgService(state)).toThrow(
      '[slingshot-organizations] organizations org service is not available',
    );
  });
});
