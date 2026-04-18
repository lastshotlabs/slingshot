import type { PermissionRegistry, ResourceTypeDefinition } from '@lastshotlabs/slingshot-core';
import { SUPER_ADMIN_ROLE } from '@lastshotlabs/slingshot-core';

/**
 * Creates an in-memory `PermissionRegistry` for registering resource type definitions.
 *
 * The registry maps resource types (e.g. `'posts'`, `'admin:billing'`) to their allowed
 * roles and the actions each role grants. Once registered, a resource type is immutable —
 * re-registration throws to enforce clean domain ownership.
 *
 * The super-admin role (`SUPER_ADMIN_ROLE`) always returns `['*']` for any resource type,
 * regardless of what is registered.
 *
 * @returns A `PermissionRegistry` instance.
 *
 * @example
 * ```ts
 * import { createPermissionRegistry, SUPER_ADMIN_ROLE } from '@lastshotlabs/slingshot-permissions';
 *
 * const registry = createPermissionRegistry();
 * registry.register({
 *   resourceType: 'posts',
 *   roles: {
 *     viewer: ['read'],
 *     editor: ['read', 'write'],
 *     admin: ['read', 'write', 'delete'],
 *   },
 * });
 * ```
 */
export function createPermissionRegistry(): PermissionRegistry {
  const definitions = new Map<string, ResourceTypeDefinition>();

  return {
    register(definition: ResourceTypeDefinition): void {
      // Intentional design choice — register once, immutable thereafter. This is not a limitation;
      // it enforces clean domain ownership. Extending a domain means adding a new resource type
      // (e.g. `admin:billing`), not re-registering an existing one with more actions. If you need
      // to extend another plugin's namespace, that plugin must own the registration.
      if (definitions.has(definition.resourceType)) {
        throw new Error(`Resource type '${definition.resourceType}' is already registered`);
      }
      definitions.set(definition.resourceType, definition);
    },

    getActionsForRole(resourceType: string, role: string): string[] {
      // super-admin always gets ['*'] regardless of resourceType
      if (role === SUPER_ADMIN_ROLE) {
        return ['*'];
      }
      const definition = definitions.get(resourceType);
      if (!definition) return [];
      return definition.roles[role] ?? [];
    },

    getDefinition(resourceType: string): ResourceTypeDefinition | null {
      return definitions.get(resourceType) ?? null;
    },

    listResourceTypes(): ResourceTypeDefinition[] {
      return Array.from(definitions.values());
    },
  };
}
