import type { DefineInfraConfig, ServiceDeclaration } from '../types/infra';
import type { DefinePlatformConfig } from '../types/platform';
import type { RegistryDocument } from '../types/registry';

/**
 * Resolve the environment variable map for a service at deploy time.
 *
 * Merges env sources in priority order (later sources override earlier ones):
 * 1. Platform stage env (`platform.stages[stageName].env`).
 * 2. Resource outputs auto-wired for resources listed in `service.uses` or `infra.uses`.
 * 3. App-level env from `infra.env`.
 * 4. Service-level env from `service.env` (highest priority).
 *
 * @param platform - Frozen platform config.
 * @param infra - Frozen infra config.
 * @param stageName - Deployment stage to resolve env for.
 * @param registry - Current registry document for resource output lookup.
 * @param service - Optional service declaration for service-level overrides.
 * @returns A flat `Record<string, string>` of all resolved env vars.
 *
 * @example
 * ```ts
 * import { resolveEnvironment } from '@lastshotlabs/slingshot-infra';
 *
 * const env = resolveEnvironment(platform, infra, 'production', registryDoc);
 * // { DATABASE_URL: '...', REDIS_URL: '...', NODE_ENV: 'production', ... }
 * ```
 */
export function resolveEnvironment(
  platform: DefinePlatformConfig,
  infra: DefineInfraConfig,
  stageName: string,
  registry: RegistryDocument,
  service?: ServiceDeclaration,
): Record<string, string> {
  const env: Record<string, string> = {};

  // 1. Platform stage env
  const stageEnv = Object.prototype.hasOwnProperty.call(platform.stages, stageName)
    ? platform.stages[stageName].env
    : undefined;
  if (stageEnv) {
    Object.assign(env, stageEnv);
  }

  // 2. Auto-wire resource outputs for resources the service `uses`
  const usedResources = service?.uses ?? infra.uses ?? [];
  for (const resourceName of usedResources) {
    const resourceEntry = Object.prototype.hasOwnProperty.call(registry.resources, resourceName)
      ? registry.resources[resourceName]
      : undefined;
    if (!resourceEntry) continue;
    const stageData = Object.prototype.hasOwnProperty.call(resourceEntry.stages, stageName)
      ? resourceEntry.stages[stageName]
      : undefined;
    if (!stageData) continue;
    Object.assign(env, stageData.outputs);
  }

  // 3. App-level env from slingshot.infra.ts
  if (infra.env) {
    Object.assign(env, infra.env);
  }

  // 4. Service-level env (overrides app-level)
  if (service?.env) {
    Object.assign(env, service.env);
  }

  return env;
}
