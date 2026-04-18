import { RESOURCE_ENV_KEYS } from '../types/resource';

/**
 * Resolve the required secret/env var keys for an app based on its resource usage.
 *
 * Collects all unique resources from `infra.uses` and each service's `uses`
 * array, looks them up in `RESOURCE_ENV_KEYS`, and appends the always-required
 * baseline keys (`JWT_SECRET`, `DATA_ENCRYPTION_KEY`).
 *
 * @param infra - A minimal infra config shape containing optional `uses` and `services`.
 * @returns A de-duplicated array of env var key names that must be present in
 *   the secrets store before deployment.
 *
 * @example
 * ```ts
 * import { resolveRequiredKeys } from '@lastshotlabs/slingshot-infra';
 *
 * const keys = resolveRequiredKeys({ uses: ['postgres', 'redis'] });
 * // ['DATABASE_URL', 'PGHOST', ..., 'REDIS_HOST', ..., 'JWT_SECRET', 'DATA_ENCRYPTION_KEY']
 * ```
 */
export function resolveRequiredKeys(infra: {
  uses?: string[];
  services?: Record<string, { uses?: string[] }>;
}): string[] {
  const keys: string[] = [];
  const allUses = new Set<string>(infra.uses ?? []);
  if (infra.services) {
    for (const svc of Object.values(infra.services)) {
      for (const u of svc.uses ?? []) allUses.add(u);
    }
  }
  for (const resource of allUses) {
    const envKeys = Object.prototype.hasOwnProperty.call(RESOURCE_ENV_KEYS, resource)
      ? RESOURCE_ENV_KEYS[resource]
      : undefined;
    if (envKeys) keys.push(...envKeys);
  }
  keys.push('JWT_SECRET', 'DATA_ENCRYPTION_KEY');
  return [...new Set(keys)];
}
