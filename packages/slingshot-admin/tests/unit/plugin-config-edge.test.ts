/**
 * Edge-case coverage for admin plugin config validation.
 *
 * Builds on the core plugin health tests in plugin-health.test.ts and
 * resourceTypes.test.ts (mountPath validation). Covers missing required
 * providers, invalid provider types, permissions shape validation,
 * mountPath normalization edge cases, and optional provider behavior.
 */
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
import { adminPluginConfigSchema } from '../../src/types/config';

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

// ---------------------------------------------------------------------------
// Missing required providers
// ---------------------------------------------------------------------------

describe('createAdminPlugin: missing required providers', () => {
  test('throws when accessProvider is missing', () => {
    expect(() =>
      // @ts-expect-error — testing missing required field
      createAdminPlugin({
        managedUserProvider,
        permissions,
      }),
    ).toThrow();
  });

  test('throws when managedUserProvider is missing', () => {
    expect(() =>
      // @ts-expect-error — testing missing required field
      createAdminPlugin({
        accessProvider,
        permissions,
      }),
    ).toThrow();
  });

  test('throws when permissions is missing', () => {
    expect(() =>
      // @ts-expect-error — testing missing required field
      createAdminPlugin({
        accessProvider,
        managedUserProvider,
      }),
    ).toThrow();
  });

  test('throws when accessProvider is null', () => {
    expect(() =>
      createAdminPlugin({
        // @ts-expect-error — testing null provider
        accessProvider: null,
        managedUserProvider,
        permissions,
      }),
    ).toThrow();
  });

  test('throws when managedUserProvider is null', () => {
    expect(() =>
      createAdminPlugin({
        accessProvider,
        // @ts-expect-error — testing null provider
        managedUserProvider: null,
        permissions,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Invalid provider types
// ---------------------------------------------------------------------------

describe('createAdminPlugin: invalid provider types', () => {
  test('throws when accessProvider is a plain object without verifyRequest', () => {
    expect(() =>
      createAdminPlugin({
        accessProvider: {} as unknown as AdminAccessProvider,
        managedUserProvider,
        permissions,
      }),
    ).toThrow(/verifyRequest/);
  });

  test('throws when managedUserProvider is missing listUsers', () => {
    expect(() =>
      createAdminPlugin({
        accessProvider,
        managedUserProvider: { getUser: async () => null } as unknown as ManagedUserProvider,
        permissions,
      }),
    ).toThrow(/listUsers/);
  });

  test('throws when managedUserProvider is missing getUser', () => {
    expect(() =>
      createAdminPlugin({
        accessProvider,
        managedUserProvider: {
          listUsers: async () => ({ items: [], nextCursor: undefined }),
          getCapabilities: () => ({}),
        } as unknown as ManagedUserProvider,
        permissions,
      }),
    ).toThrow(/getUser/);
  });

  test('throws when permissions.evaluator is missing can', () => {
    expect(() =>
      createAdminPlugin({
        accessProvider,
        managedUserProvider,
        permissions: {
          ...permissions,
          evaluator: {} as unknown as PermissionEvaluator,
        },
      }),
    ).toThrow(/can/);
  });

  test('throws when permissions.registry is missing getDefinition', () => {
    expect(() =>
      createAdminPlugin({
        accessProvider,
        managedUserProvider,
        permissions: {
          ...permissions,
          registry: {} as unknown as PermissionRegistry,
        },
      }),
    ).toThrow(/getDefinition/);
  });

  test('throws when permissions.adapter is missing createGrant', () => {
    expect(() =>
      createAdminPlugin({
        accessProvider,
        managedUserProvider,
        permissions: {
          ...permissions,
          adapter: {} as unknown as PermissionsAdapter,
        },
      }),
    ).toThrow(/createGrant/);
  });
});

// ---------------------------------------------------------------------------
// mountPath validation edge cases
// ---------------------------------------------------------------------------

describe('adminPluginConfigSchema mountPath edge cases', () => {
  test('normalizes mountPath by removing trailing slashes', () => {
    const config = adminPluginConfigSchema.parse({
      accessProvider,
      managedUserProvider,
      permissions,
      mountPath: '/admin/',
    } as unknown as Parameters<typeof adminPluginConfigSchema.parse>[0]);
    expect(config.mountPath).toBe('/admin');
  });

  test('rejects mountPath of just "/"', () => {
    expect(() =>
      adminPluginConfigSchema.parse({
        mountPath: '/',
      } as unknown as Parameters<typeof adminPluginConfigSchema.parse>[0]),
    ).toThrow("mountPath must not be '/'");
  });

  test('rejects mountPath without leading slash', () => {
    expect(() =>
      adminPluginConfigSchema.parse({
        mountPath: 'admin',
      } as unknown as Parameters<typeof adminPluginConfigSchema.parse>[0]),
    ).toThrow("mountPath must start with '/'");
  });

  test('mountPath defaults to undefined when not provided', () => {
    const config = adminPluginConfigSchema.parse({
      accessProvider,
      managedUserProvider,
      permissions,
    } as unknown as Parameters<typeof adminPluginConfigSchema.parse>[0]);
    expect(config.mountPath).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Optional providers edge cases
// ---------------------------------------------------------------------------

describe('createAdminPlugin: optional providers', () => {
  test('plugin is created and healthy with auditLog configured', () => {
    const auditLog: AuditLogProvider = {
      async logEntry() {},
      async getLogs() {
        return { items: [], nextCursor: undefined };
      },
    };
    const plugin = createAdminPlugin({
      accessProvider,
      managedUserProvider,
      permissions,
      auditLog,
    });
    expect(plugin.getHealth().status).toBe('degraded'); // no rateLimitStore
    expect(plugin.getHealth().details.auditLogConfigured).toBe(true);
  });

  test('plugin reports degraded when auditLog is set but rateLimitStore is not', () => {
    const auditLog: AuditLogProvider = {
      async logEntry() {},
      async getLogs() {
        return { items: [], nextCursor: undefined };
      },
    };
    const plugin = createAdminPlugin({
      accessProvider,
      managedUserProvider,
      permissions,
      auditLog,
    });
    expect(plugin.getHealth().status).toBe('degraded');
  });

  test('plugin reports unhealthy without auditLog even with rateLimitStore', () => {
    const rateLimitStore: AdminRateLimitStore = {
      async hit() {
        return { count: 0, exceeded: false, resetAt: 0 };
      },
    };
    const plugin = createAdminPlugin({
      accessProvider,
      managedUserProvider,
      permissions,
      rateLimitStore,
    });
    expect(plugin.getHealth().status).toBe('unhealthy');
  });

  test('mailRenderer defaults are reflected in health', () => {
    const plugin = createAdminPlugin({ accessProvider, managedUserProvider, permissions });
    expect(plugin.getHealth().details.mailRendererConfigured).toBe(false);
  });
});
