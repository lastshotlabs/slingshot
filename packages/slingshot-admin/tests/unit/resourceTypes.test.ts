import { describe, expect, test } from 'bun:test';
import type { PermissionRegistry } from '@lastshotlabs/slingshot-core';
import { registerAdminResourceTypes } from '../../src/lib/resourceTypes';
import { adminPluginConfigSchema } from '../../src/types/config';

// ---------------------------------------------------------------------------
// Minimal in-memory registry for testing
// ---------------------------------------------------------------------------

function createTestRegistry(): PermissionRegistry & {
  all(): Array<{ resourceType: string; actions: string[]; roles: Record<string, string[]> }>;
} {
  type Def = { resourceType: string; actions: string[]; roles: Record<string, string[]> };
  const defs = new Map<string, Def>();
  return {
    register(def: Def) {
      defs.set(def.resourceType, def);
    },
    getDefinition(resourceType: string) {
      return defs.get(resourceType) ?? null;
    },
    listResourceTypes() {
      return Array.from(defs.values());
    },
    getActionsForRole(resourceType: string, role: string) {
      if (role === 'super-admin') return ['*'];
      return defs.get(resourceType)?.roles[role] ?? [];
    },
    all() {
      return Array.from(defs.values());
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerAdminResourceTypes', () => {
  test('registers all six expected resource types', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);

    const types = registry.all().map(d => d.resourceType);
    expect(types).toContain('admin:user');
    expect(types).toContain('admin:session');
    expect(types).toContain('admin:role');
    expect(types).toContain('admin:audit');
    expect(types).toContain('admin:permission');
    expect(types).toContain('admin:mail');
  });

  test('admin:user has read/write/suspend/delete actions', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);
    const def = registry.getDefinition('admin:user');
    expect(def?.actions).toContain('read');
    expect(def?.actions).toContain('write');
    expect(def?.actions).toContain('suspend');
    expect(def?.actions).toContain('delete');
  });

  test('tenant-admin role has read/write/suspend on admin:user', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);
    const actions = registry.getActionsForRole('admin:user', 'tenant-admin');
    expect(actions).toContain('read');
    expect(actions).toContain('write');
    expect(actions).toContain('suspend');
  });

  test('support role only has read on admin:user (not write/suspend/delete)', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);
    const actions = registry.getActionsForRole('admin:user', 'support');
    expect(actions).toContain('read');
    expect(actions).not.toContain('write');
    expect(actions).not.toContain('delete');
  });

  test('admin:session has read and revoke actions', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);
    const def = registry.getDefinition('admin:session');
    expect(def?.actions).toContain('read');
    expect(def?.actions).toContain('revoke');
  });

  test('admin:audit has read action and is accessible to auditor role', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);
    const actions = registry.getActionsForRole('admin:audit', 'auditor');
    expect(actions).toContain('read');
  });

  test('admin:mail only has read action', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);
    const def = registry.getDefinition('admin:mail');
    expect(def?.actions).toEqual(['read']);
  });

  test('is idempotent — calling twice does not error', () => {
    const registry = createTestRegistry();
    expect(() => {
      registerAdminResourceTypes(registry);
      registerAdminResourceTypes(registry);
    }).not.toThrow();
  });
});

describe('adminPluginConfigSchema mountPath', () => {
  test('rejects mountPath values without a leading slash', () => {
    expect(() => adminPluginConfigSchema.parse({ mountPath: 'admin' })).toThrow(
      /mountPath must start with '\//i,
    );
  });
});
