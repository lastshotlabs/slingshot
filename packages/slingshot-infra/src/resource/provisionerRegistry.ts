import type { ResourceProvisioner } from '../types/resource';

/**
 * Create an in-memory registry of resource provisioners keyed by resource type.
 *
 * Throws immediately when an unknown resource type is requested so errors
 * surface at provision time rather than silently skipping resources.
 *
 * @param provisioners - Array of `ResourceProvisioner` instances to register.
 * @returns An object with `get(type)` for single-provisioner dispatch and
 *   `types()` for listing registered resource types.
 *
 * @throws {Error} If `get()` is called with a type that was not registered.
 *
 * @example
 * ```ts
 * import {
 *   createProvisionerRegistry,
 *   createPostgresProvisioner,
 *   createRedisProvisioner,
 * } from '@lastshotlabs/slingshot-infra';
 *
 * const registry = createProvisionerRegistry([
 *   createPostgresProvisioner(),
 *   createRedisProvisioner(),
 * ]);
 * const pg = registry.get('postgres');
 * ```
 */
export function createProvisionerRegistry(provisioners: ResourceProvisioner[]): {
  get(type: string): ResourceProvisioner;
  types(): string[];
} {
  const map = new Map(provisioners.map(p => [p.resourceType, p]));
  return {
    get(type: string) {
      const p = map.get(type);
      if (!p) {
        throw new Error(
          `[slingshot-infra] No provisioner for resource type: "${type}". ` +
            `Available: ${[...map.keys()].join(', ')}`,
        );
      }
      return p;
    },
    types: () => [...map.keys()],
  };
}
