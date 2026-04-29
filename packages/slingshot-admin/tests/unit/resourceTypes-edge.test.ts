import { describe, expect, test } from 'bun:test';
import { createPermissionRegistry } from '@lastshotlabs/slingshot-core';
import { registerAdminResourceTypes } from '../../src/lib/resourceTypes';

describe('registerAdminResourceTypes', () => {
  test('registers admin:user resource type', () => {
    const registry = createPermissionRegistry();
    registerAdminResourceTypes(registry);
    const types = registry.getResourceTypes();
    expect(types).toContain('admin:user');
  });

  test('registers all 6 resource types', () => {
    const registry = createPermissionRegistry();
    registerAdminResourceTypes(registry);
    const types = registry.getResourceTypes();
    expect(types).toContain('admin:user');
    expect(types).toContain('admin:session');
    expect(types).toContain('admin:role');
    expect(types).toContain('admin:audit');
    expect(types).toContain('admin:permission');
    expect(types).toContain('admin:mail');
  });

  test('tenant-admin has user:read, user:write, user:suspend', () => {
    const registry = createPermissionRegistry();
    registerAdminResourceTypes(registry);
    const actions = registry.getActionsForRole('admin:user', 'tenant-admin');
    expect(actions).toContain('read');
    expect(actions).toContain('write');
    expect(actions).toContain('suspend');
    expect(actions).not.toContain('delete');
  });

  test('support role has admin:audit read', () => {
    const registry = createPermissionRegistry();
    registerAdminResourceTypes(registry);
    const actions = registry.getActionsForRole('admin:audit', 'support');
    expect(actions).toContain('read');
  });

  test('auditor role has admin:audit read', () => {
    const registry = createPermissionRegistry();
    registerAdminResourceTypes(registry);
    const actions = registry.getActionsForRole('admin:audit', 'auditor');
    expect(actions).toContain('read');
  });

  test('super-admin is not in roles map but handled specially', () => {
    const registry = createPermissionRegistry();
    registerAdminResourceTypes(registry);
    const actions = registry.getActionsForRole('admin:user', 'super-admin');
    expect(actions).toContain('*');
  });

  test('unknown role gets empty actions', () => {
    const registry = createPermissionRegistry();
    registerAdminResourceTypes(registry);
    const actions = registry.getActionsForRole('admin:user', 'unknown-role');
    expect(actions).toEqual([]);
  });

  test('idempotent - can be called multiple times', () => {
    const registry = createPermissionRegistry();
    registerAdminResourceTypes(registry);
    expect(() => registerAdminResourceTypes(registry)).not.toThrow();
  });
});
