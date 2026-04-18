import type { PresetProvider } from '../types/preset';

/**
 * Create an in-memory registry of preset providers keyed by name.
 *
 * Throws immediately when an unknown preset name is requested so errors surface
 * at deploy time rather than silently producing empty output.
 *
 * @param presets - Array of `PresetProvider` instances to register.
 * @returns An object with `get(name)` for single-preset dispatch and `names()`
 *   for listing registered preset names.
 *
 * @throws {Error} If `get()` is called with a name that was not registered.
 *
 * @example
 * ```ts
 * import { createPresetRegistry, createEcsPreset, createEc2NginxPreset } from '@lastshotlabs/slingshot-infra';
 *
 * const presets = createPresetRegistry([createEcsPreset(), createEc2NginxPreset()]);
 * const ecs = presets.get('ecs'); // createEcsPreset() instance
 * ```
 */
export function createPresetRegistry(presets: PresetProvider[]): {
  get(name: string): PresetProvider;
  names(): string[];
} {
  const map = new Map(presets.map(p => [p.name, p]));
  return {
    get(name: string) {
      const preset = map.get(name);
      if (!preset) {
        throw new Error(
          `[slingshot-infra] Unknown preset: "${name}". ` +
            `Available: ${[...map.keys()].join(', ')}`,
        );
      }
      return preset;
    },
    names: () => [...map.keys()],
  };
}
