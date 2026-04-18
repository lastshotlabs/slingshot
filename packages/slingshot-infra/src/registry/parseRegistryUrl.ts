import type { RegistryConfig } from '../types/platform';

/**
 * Parse a `SLINGSHOT_REGISTRY` URL string into a `RegistryConfig`.
 *
 * Supported URL schemes:
 * - `s3://<bucket>` → `{ provider: 's3', bucket }`
 * - `redis://<host>:<port>` or `rediss://...` → `{ provider: 'redis', url }`
 * - `postgres://...` or `postgresql://...` → `{ provider: 'postgres', connectionString }`
 * - Any other string (filesystem path) → `{ provider: 'local', path }`
 *
 * @param url - The URL or path string to parse.
 * @returns A `RegistryConfig` for use with `createRegistryFromConfig()`.
 *
 * @example
 * ```ts
 * import { parseRegistryUrl } from '@lastshotlabs/slingshot-infra';
 *
 * const config = parseRegistryUrl('s3://my-bucket');
 * // { provider: 's3', bucket: 'my-bucket' }
 *
 * const config2 = parseRegistryUrl(process.env.SLINGSHOT_REGISTRY ?? '.slingshot/registry.json');
 * ```
 */
export function parseRegistryUrl(url: string): RegistryConfig {
  if (url.startsWith('s3://')) {
    return { provider: 's3', bucket: url.slice(5) };
  }
  if (url.startsWith('redis://') || url.startsWith('rediss://')) {
    return { provider: 'redis', url };
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return { provider: 'postgres', connectionString: url };
  }
  return { provider: 'local', path: url };
}
