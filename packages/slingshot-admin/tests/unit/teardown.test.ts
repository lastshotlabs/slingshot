/**
 * Tests for the admin plugin teardown lifecycle hook.
 *
 * Covers teardown invocation, metrics reset, and no-op safety (teardown
 * on a minimal config should not throw).
 */
import { describe, expect, test } from 'bun:test';
import type {
  AdminAccessProvider,
  ManagedUserProvider,
  PermissionEvaluator,
  PermissionRegistry,
  PermissionsAdapter,
} from '@lastshotlabs/slingshot-core';
import { createAdminPlugin } from '../../src/plugin';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const accessProvider = {
  name: 'test-access',
  async verifyRequest() {
    return { subject: 'admin', provider: 'test' };
  },
} as unknown as AdminAccessProvider;

const managedUserProvider = {
  name: 'test-managed',
  async listUsers() {
    return { items: [], nextCursor: undefined };
  },
  async getUser() {
    return null;
  },
  getCapabilities() {
    return {};
  },
} as unknown as ManagedUserProvider;

const permissions = {
  evaluator: { can: async () => true } as unknown as PermissionEvaluator,
  registry: { getDefinition: () => undefined } as unknown as PermissionRegistry,
  adapter: { createGrant: async () => '' } as unknown as PermissionsAdapter,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAdminPlugin teardown()', () => {
  test('teardown does not throw on a minimal config', async () => {
    const plugin = createAdminPlugin({
      accessProvider,
      managedUserProvider,
      permissions,
    });

    // Should not throw — teardown should be safe to call even when
    // nothing was set up
    await expect(plugin.teardown?.()).resolves.toBeUndefined();
  });

  test('teardown is a function on the returned plugin', () => {
    const plugin = createAdminPlugin({
      accessProvider,
      managedUserProvider,
      permissions,
    });

    expect(plugin.teardown).toBeDefined();
    expect(typeof plugin.teardown).toBe('function');
  });

  test('teardown can be called multiple times without error', async () => {
    const plugin = createAdminPlugin({
      accessProvider,
      managedUserProvider,
      permissions,
    });

    await plugin.teardown?.();
    await plugin.teardown?.();
    await plugin.teardown?.();
    // All should succeed — no state to double-free
  });

  test('health still returns valid data after teardown', async () => {
    const plugin = createAdminPlugin({
      accessProvider,
      managedUserProvider,
      permissions,
    });

    const before = plugin.getHealth();
    expect(before.status).toBe('unhealthy');

    await plugin.teardown?.();

    const after = plugin.getHealth();
    expect(after.status).toBe('unhealthy');
    expect(after.details.auditLogConfigured).toBe(before.details.auditLogConfigured);
    expect(after.details.mountPath).toBe(before.details.mountPath);
  });

  test('teardown with full config (all optional providers)', async () => {
    const plugin = createAdminPlugin({
      accessProvider,
      managedUserProvider,
      permissions,
      auditLog: {
        async logEntry() {},
        async getLogs() {
          return { items: [], nextCursor: undefined };
        },
      },
      rateLimitStore: {
        async hit() {
          return { count: 0, exceeded: false, resetAt: 0 };
        },
      },
      mailRenderer: {
        name: 'test',
        async render() {
          return { html: '' };
        },
        async listTemplates() {
          return [];
        },
      },
    });

    expect(plugin.getHealth().status).toBe('healthy');
    await expect(plugin.teardown?.()).resolves.toBeUndefined();
  });
});
