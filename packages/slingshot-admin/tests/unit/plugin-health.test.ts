import { describe, expect, test } from 'bun:test';
import type {
  AdminAccessProvider,
  AuditLogProvider,
  ManagedUserProvider,
  PermissionEvaluator,
  PermissionRegistry,
  PermissionsAdapter,
} from '@lastshotlabs/slingshot-core';
import type { AdminRateLimitStore } from '../../src/lib/rateLimitStore';
import { createAdminPlugin } from '../../src/plugin';

const accessProvider = {
  async verifyRequest() {
    return null;
  },
} as unknown as AdminAccessProvider;

const managedUserProvider = {
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

const auditLog: AuditLogProvider = {
  async logEntry() {},
  async getLogs() {
    return { items: [], nextCursor: undefined };
  },
};

const rateLimitStore: AdminRateLimitStore = {
  async hit() {
    return { count: 0, exceeded: false, resetAt: 0 };
  },
};

describe('createAdminPlugin getHealth()', () => {
  test('returns degraded when no audit-log provider is configured', () => {
    const plugin = createAdminPlugin({ accessProvider, managedUserProvider, permissions });
    const health = plugin.getHealth();
    expect(health.status).toBe('degraded');
    expect(health.details.auditLogConfigured).toBe(false);
    expect(health.details.rateLimitStoreConfigured).toBe(false);
    expect(health.details.mailRendererConfigured).toBe(false);
    expect(health.details.mountPath).toBe('/admin');
  });

  test('returns degraded when audit log is configured but no rate-limit store is provided', () => {
    const plugin = createAdminPlugin({
      accessProvider,
      managedUserProvider,
      permissions,
      auditLog,
    });
    const health = plugin.getHealth();
    expect(health.status).toBe('degraded');
    expect(health.details.auditLogConfigured).toBe(true);
    expect(health.details.rateLimitStoreConfigured).toBe(false);
  });

  test('returns healthy when both audit log and rate-limit store are configured', () => {
    const plugin = createAdminPlugin({
      accessProvider,
      managedUserProvider,
      permissions,
      auditLog,
      rateLimitStore,
    });
    const health = plugin.getHealth();
    expect(health.status).toBe('healthy');
    expect(health.details.auditLogConfigured).toBe(true);
    expect(health.details.rateLimitStoreConfigured).toBe(true);
  });
});
