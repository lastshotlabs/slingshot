import { describe, expect, test } from 'bun:test';
import {
  ORGANIZATIONS_RECONCILE_STATE_KEY,
  getOrganizationsReconcile,
  getOrganizationsReconcileOrNull,
} from '../../src/reconcile';

function makeValidReconcileService() {
  return {
    reconcileOrphanedOrgRecords: async () => ({
      orgId: 'org-1',
      orgGone: true,
      failed: [] as ReadonlyArray<string>,
    }),
  };
}

function makePluginState(key: string, value: unknown) {
  return { pluginState: new Map([[key, value]]) };
}

describe('getOrganizationsReconcileOrNull', () => {
  test('returns null when input is null', () => {
    expect(getOrganizationsReconcileOrNull(null)).toBeNull();
  });

  test('returns null when input is undefined', () => {
    expect(getOrganizationsReconcileOrNull(undefined)).toBeNull();
  });

  test('returns null when pluginState has no reconcile entry', () => {
    const state = makePluginState('some.other.key', {});
    expect(getOrganizationsReconcileOrNull(state)).toBeNull();
  });

  test('returns null when reconcile entry lacks reconcileOrphanedOrgRecords method', () => {
    const partial = { notTheRightMethod: async () => {} };
    const state = makePluginState(ORGANIZATIONS_RECONCILE_STATE_KEY, partial);
    expect(getOrganizationsReconcileOrNull(state)).toBeNull();
  });

  test('returns null when reconcile entry is not an object', () => {
    const state = makePluginState(ORGANIZATIONS_RECONCILE_STATE_KEY, 'not-a-service');
    expect(getOrganizationsReconcileOrNull(state)).toBeNull();
  });

  test('returns the service when reconcileOrphanedOrgRecords is a function', () => {
    const service = makeValidReconcileService();
    const state = makePluginState(ORGANIZATIONS_RECONCILE_STATE_KEY, service);
    expect(getOrganizationsReconcileOrNull(state)).toBe(service);
  });
});

describe('getOrganizationsReconcile', () => {
  test('returns the service when available', () => {
    const service = makeValidReconcileService();
    const state = makePluginState(ORGANIZATIONS_RECONCILE_STATE_KEY, service);
    expect(getOrganizationsReconcile(state)).toBe(service);
  });

  test('throws a descriptive error when service is not available', () => {
    expect(() => getOrganizationsReconcile(null)).toThrow(
      '[slingshot-organizations] organizations reconcile service is not available in pluginState',
    );
  });

  test('throws when pluginState entry is missing required methods', () => {
    const state = makePluginState(ORGANIZATIONS_RECONCILE_STATE_KEY, {});
    expect(() => getOrganizationsReconcile(state)).toThrow(
      '[slingshot-organizations] organizations reconcile service is not available in pluginState',
    );
  });
});
