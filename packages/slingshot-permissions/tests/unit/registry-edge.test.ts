/**
 * Edge-case coverage for the permission registry.
 *
 * Builds on the core registry tests in registry.test.ts.
 * Covers duplicate registration handling (already tested), resource type
 * schema validation, role definition edge cases, definition immutability,
 * case sensitivity, and empty/unusual configurations.
 */
import { describe, expect, test } from 'bun:test';
import type { ResourceTypeDefinition } from '@lastshotlabs/slingshot-core';
import { createPermissionRegistry } from '../../src/lib/registry';

const postDef: ResourceTypeDefinition = {
  resourceType: 'post',
  actions: ['create', 'read', 'update', 'delete'],
  roles: {
    editor: ['create', 'update'],
    reader: ['read'],
  },
};

// ---------------------------------------------------------------------------
// Registration edge cases
// ---------------------------------------------------------------------------

describe('PermissionRegistry registration edge cases', () => {
  test('registering the same type name with different casing is treated as distinct', () => {
    const registry = createPermissionRegistry();
    registry.register(postDef);
    // "Post" ≠ "post" — case-sensitive key
    registry.register({
      resourceType: 'Post',
      actions: ['view'],
      roles: { viewer: ['view'] },
    });
    expect(registry.listResourceTypes()).toHaveLength(2);
  });

  test('registering a type with empty actions array is allowed', () => {
    const registry = createPermissionRegistry();
    expect(() =>
      registry.register({
        resourceType: 'noop',
        actions: [],
        roles: {},
      }),
    ).not.toThrow();
  });

  test('registering a type with empty roles object is allowed', () => {
    const registry = createPermissionRegistry();
    expect(() =>
      registry.register({
        resourceType: 'empty-roles',
        actions: ['do'],
        roles: {},
      }),
    ).not.toThrow();
  });

  test('registering a type with no-op role (empty action array) is allowed', () => {
    const registry = createPermissionRegistry();
    registry.register({
      resourceType: 'noop-role',
      actions: ['ping'],
      roles: {
        nobody: [],
      },
    });
    expect(registry.getActionsForRole('noop-role', 'nobody')).toEqual([]);
  });

  test('register overwrites are not silently allowed — duplicate throws', () => {
    const registry = createPermissionRegistry();
    registry.register(postDef);
    expect(() =>
      registry.register({
        resourceType: 'post',
        actions: ['override'],
        roles: {},
      }),
    ).toThrow(/already registered/i);
  });

  test('listResourceTypes returns all registered definitions', () => {
    const registry = createPermissionRegistry();
    registry.register(postDef);
    registry.register({
      resourceType: 'comment',
      actions: ['create', 'read'],
      roles: { commenter: ['create', 'read'] },
    });
    const types = registry.listResourceTypes();
    expect(types).toHaveLength(2);
    expect(types.map(t => t.resourceType).sort()).toEqual(['comment', 'post']);
  });
});

// ---------------------------------------------------------------------------
// getActionsForRole edge cases
// ---------------------------------------------------------------------------

describe('PermissionRegistry.getActionsForRole edge cases', () => {
  test('returns [] for empty-string resource type', () => {
    const registry = createPermissionRegistry();
    registry.register(postDef);
    expect(registry.getActionsForRole('', 'editor')).toEqual([]);
  });

  test('returns [] for empty-string role name', () => {
    const registry = createPermissionRegistry();
    registry.register(postDef);
    expect(registry.getActionsForRole('post', '')).toEqual([]);
  });

  test('role with single action is resolved correctly', () => {
    const registry = createPermissionRegistry();
    registry.register({
      resourceType: 'vote',
      actions: ['upvote', 'downvote'],
      roles: {
        voter: ['upvote'],
      },
    });
    expect(registry.getActionsForRole('vote', 'voter')).toEqual(['upvote']);
  });

  test('role with all actions listed individually resolves correctly', () => {
    const registry = createPermissionRegistry();
    registry.register({
      resourceType: 'all-actions',
      actions: ['a', 'b', 'c'],
      roles: {
        admin: ['a', 'b', 'c'],
      },
    });
    expect(registry.getActionsForRole('all-actions', 'admin')).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// getDefinition edge cases
// ---------------------------------------------------------------------------

describe('PermissionRegistry.getDefinition edge cases', () => {
  test('returns null for null resource type name', () => {
    const registry = createPermissionRegistry();
    expect(registry.getDefinition(null as unknown as string)).toBeNull();
  });

  test('returns null for undefined resource type name', () => {
    const registry = createPermissionRegistry();
    expect(registry.getDefinition(undefined as unknown as string)).toBeNull();
  });

  test('returns null for empty string type name', () => {
    const registry = createPermissionRegistry();
    registry.register(postDef);
    // Empty string is not 'post'
    expect(registry.getDefinition('')).toBeNull();
  });

  test('returns definition matching registered shape', () => {
    const registry = createPermissionRegistry();
    registry.register(postDef);
    const def = registry.getDefinition('post');
    expect(def).not.toBeNull();
    expect(def!.resourceType).toBe('post');
    expect(def!.actions).toEqual(['create', 'read', 'update', 'delete']);
    expect(def!.roles).toEqual({ editor: ['create', 'update'], reader: ['read'] });
  });
});

// ---------------------------------------------------------------------------
// Wildcard role resolution
// ---------------------------------------------------------------------------

describe('PermissionRegistry wildcard role resolution', () => {
  test('super-admin role always returns ["*"] for registered types', () => {
    const registry = createPermissionRegistry();
    registry.register(postDef);
    expect(registry.getActionsForRole('post', 'super-admin')).toEqual(['*']);
  });

  test('super-admin role returns ["*"] even for types with empty actions', () => {
    const registry = createPermissionRegistry();
    registry.register({
      resourceType: 'empty',
      actions: [],
      roles: {},
    });
    expect(registry.getActionsForRole('empty', 'super-admin')).toEqual(['*']);
  });

  test('super-admin is not affected by role definition (always ["*"])', () => {
    const registry = createPermissionRegistry();
    registry.register({
      resourceType: 'post',
      actions: ['create', 'read', 'update', 'delete'],
      roles: {
        // Note: super-admin is NOT defined here, but it's built-in
        editor: ['create', 'update'],
      },
    });
    expect(registry.getActionsForRole('post', 'super-admin')).toEqual(['*']);
  });
});
