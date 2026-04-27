import { describe, expect, test } from 'bun:test';
import {
  ORGANIZATIONS_ORG_SERVICE_STATE_KEY,
  getOrganizationsOrgService,
  getOrganizationsOrgServiceOrNull,
} from '../../src/orgService';

function makeValidService() {
  return {
    getOrgBySlug: async () => null,
    createOrg: async () => ({ id: 'org-1' }),
    addOrgMember: async () => undefined,
  };
}

function makePluginState(key: string, value: unknown) {
  return { pluginState: new Map([[key, value]]) };
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
