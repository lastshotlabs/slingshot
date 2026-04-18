import type { DefinePlatformConfig } from '../types/platform';

/**
 * Resolve multi-platform targeting by merging a named platform entry into the
 * top-level platform config.
 *
 * When `targetPlatform` is supplied, the matching entry under
 * `rawConfig.platforms[targetPlatform]` is merged over the top-level fields
 * (provider, region, registry, secrets, resources, stacks, stages, defaults).
 * This allows a single `slingshot.platform.ts` to describe multiple deployment
 * targets (e.g. different AWS accounts or regions for different clients).
 *
 * @param rawConfig - The validated top-level platform config from `definePlatform()`.
 * @param targetPlatform - Name of the platform entry to select. When `undefined`,
 *   `rawConfig` is returned unchanged.
 * @returns The resolved `DefinePlatformConfig` for `targetPlatform`.
 *
 * @throws {Error} If `targetPlatform` is provided but not found in
 *   `rawConfig.platforms`.
 *
 * @example
 * ```ts
 * import { resolvePlatformConfig } from '@lastshotlabs/slingshot-infra';
 *
 * const resolved = resolvePlatformConfig(rawPlatform, 'client-a');
 * // resolved.region is now client-a's region, not the top-level default
 * ```
 */
export function resolvePlatformConfig(
  rawConfig: DefinePlatformConfig,
  targetPlatform?: string,
): DefinePlatformConfig {
  if (!targetPlatform) return rawConfig;

  const entry = rawConfig.platforms?.[targetPlatform];
  if (!entry) {
    const available = Object.keys(rawConfig.platforms ?? {});
    throw new Error(
      `[slingshot-infra] Platform "${targetPlatform}" not found. ` +
        `Available: ${available.length > 0 ? available.join(', ') : '(none)'}`,
    );
  }

  return {
    ...rawConfig,
    provider: entry.provider,
    region: entry.region,
    registry: entry.registry,
    secrets: entry.secrets ?? rawConfig.secrets,
    resources: entry.resources ?? rawConfig.resources,
    stacks: entry.stacks ?? rawConfig.stacks,
    stages: entry.stages,
    defaults: entry.defaults ?? rawConfig.defaults,
  };
}
