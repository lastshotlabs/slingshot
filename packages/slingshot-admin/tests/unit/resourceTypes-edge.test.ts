/**
 * Edge-case coverage for admin resource type registration.
 *
 * Builds on the core registration tests in resourceTypes.test.ts.
 * Covers def registration and role resolution edge cases that
 * exercise the real `registerAdminResourceTypes` function.
 */
import { describe, expect, test } from 'bun:test';
import type { PermissionRegistry } from '@lastshotlabs/slingshot-core';
import { registerAdminResourceTypes } from '../../src/lib/resourceTypes';

function createTestRegistry(throwOnDuplicate = true): PermissionRegistry {
  const defs = new Map<
    string,
    {
      resourceType: string;
      actions: string[];
      roles: Record<string, string[]>;
    }
  >();
  return {
    register(def) {
      if (throwOnDuplicate && defs.has(def.resourceType)) {
        throw new Error(`Resource type '${def.resourceType}' is already registered`);
      }
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
  };
}

describe('registerAdminResourceTypes edge cases', () => {
  test('second call on strict registry throws duplicate registration', () => {
    const registry = createTestRegistry(true);
    registerAdminResourceTypes(registry);
    expect(() => registerAdminResourceTypes(registry)).toThrow(/already registered/i);
  });

  test('admin:permission has read/write for tenant-admin only', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);
    const adminActions = registry.getActionsForRole('admin:permission', 'tenant-admin');
    expect(adminActions).toEqual(['read', 'write']);
    const supportActions = registry.getActionsForRole('admin:permission', 'support');
    expect(supportActions).toEqual([]);
  });

  test('admin:mail has read for tenant-admin and support', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);
    const adminActions = registry.getActionsForRole('admin:mail', 'tenant-admin');
    expect(adminActions).toEqual(['read']);
    const supportActions = registry.getActionsForRole('admin:mail', 'support');
    expect(supportActions).toEqual(['read']);
  });

  test('admin:role has read/write for tenant-admin, nothing for support', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);
    const actions = registry.getActionsForRole('admin:role', 'tenant-admin');
    expect(actions).toContain('read');
    expect(actions).toContain('write');
    expect(registry.getActionsForRole('admin:role', 'support')).toEqual([]);
  });

  test('admin:session has read/revoke for tenant-admin, read for support', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);
    const ta = registry.getActionsForRole('admin:session', 'tenant-admin');
    expect(ta).toContain('read');
    expect(ta).toContain('revoke');
    expect(registry.getActionsForRole('admin:session', 'support')).toEqual(['read']);
  });

  test('admin:audit is accessible to tenant-admin, support, and auditor', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);
    for (const role of ['tenant-admin', 'support', 'auditor']) {
      const actions = registry.getActionsForRole('admin:audit', role);
      expect(actions).toEqual(['read']);
    }
  });

  test('tenant-admin does not have delete on admin:user', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);
    const actions = registry.getActionsForRole('admin:user', 'tenant-admin');
    expect(actions).not.toContain('delete');
  });

  test('super-admin gets wildcard for every registered type', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);
    const types = [
      'admin:user',
      'admin:session',
      'admin:role',
      'admin:audit',
      'admin:permission',
      'admin:mail',
    ];
    for (const t of types) {
      expect(registry.getActionsForRole(t, 'super-admin')).toEqual(['*']);
    }
  });

  test('unknown role on any type returns empty array', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);
    const types = [
      'admin:user',
      'admin:session',
      'admin:role',
      'admin:audit',
      'admin:permission',
      'admin:mail',
    ];
    for (const t of types) {
      expect(registry.getActionsForRole(t, 'nonexistent-role')).toEqual([]);
    }
  });

  test('getDefinition returns exact shapes for each registered type', () => {
    const registry = createTestRegistry();
    registerAdminResourceTypes(registry);
    const userDef = registry.getDefinition('admin:user');
    expect(userDef?.actions).toEqual(['read', 'write', 'suspend', 'delete']);
    const sessionDef = registry.getDefinition('admin:session');
    expect(sessionDef?.actions).toEqual(['read', 'revoke']);
    const auditDef = registry.getDefinition('admin:audit');
    expect(auditDef?.actions).toEqual(['read']);
  });
});
