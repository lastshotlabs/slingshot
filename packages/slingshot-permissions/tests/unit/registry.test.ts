import { describe, expect, test } from 'bun:test';
import type { ResourceTypeDefinition } from '@lastshotlabs/slingshot-core';
import { createPermissionRegistry } from '../../src/lib/registry';

const testDef: ResourceTypeDefinition = {
  resourceType: 'post',
  actions: ['create', 'read', 'update', 'delete'],
  roles: {
    editor: ['create', 'update'],
    reader: ['read'],
  },
};

describe('PermissionRegistry', () => {
  test("super-admin always gets ['*'] regardless of resourceType", () => {
    const registry = createPermissionRegistry();
    registry.register(testDef);
    expect(registry.getActionsForRole('post', 'super-admin')).toEqual(['*']);
  });

  test("super-admin returns ['*'] even for unregistered resource types", () => {
    const registry = createPermissionRegistry();
    expect(registry.getActionsForRole('nonexistent', 'super-admin')).toEqual(['*']);
  });

  test('getActionsForRole returns configured actions for a known role', () => {
    const registry = createPermissionRegistry();
    registry.register(testDef);
    expect(registry.getActionsForRole('post', 'editor')).toEqual(['create', 'update']);
    expect(registry.getActionsForRole('post', 'reader')).toEqual(['read']);
  });

  test('getActionsForRole returns [] for unknown resource type', () => {
    const registry = createPermissionRegistry();
    expect(registry.getActionsForRole('unknown-type', 'editor')).toEqual([]);
  });

  test('getActionsForRole returns [] for unknown role in known resource type', () => {
    const registry = createPermissionRegistry();
    registry.register(testDef);
    expect(registry.getActionsForRole('post', 'unknown-role')).toEqual([]);
  });

  test('duplicate register() call throws', () => {
    const registry = createPermissionRegistry();
    registry.register(testDef);
    expect(() => registry.register(testDef)).toThrow("Resource type 'post' is already registered");
  });

  test('getDefinition returns null for unregistered type', () => {
    const registry = createPermissionRegistry();
    expect(registry.getDefinition('post')).toBeNull();
  });

  test('getDefinition returns definition for registered type', () => {
    const registry = createPermissionRegistry();
    registry.register(testDef);
    expect(registry.getDefinition('post')).toEqual(testDef);
  });

  test('listResourceTypes reflects all registered types', () => {
    const registry = createPermissionRegistry();
    registry.register(testDef);
    registry.register({
      resourceType: 'comment',
      actions: ['create', 'delete'],
      roles: { author: ['create', 'delete'] },
    });
    const types = registry.listResourceTypes();
    expect(types).toHaveLength(2);
    expect(types.map(t => t.resourceType)).toContain('post');
    expect(types.map(t => t.resourceType)).toContain('comment');
  });

  test('listResourceTypes returns empty array when no types registered', () => {
    const registry = createPermissionRegistry();
    expect(registry.listResourceTypes()).toEqual([]);
  });
});
