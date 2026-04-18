/**
 * Shared utilities for mapping generated file paths to override keys and
 * extracting service names from per-service Dockerfile paths.
 *
 * Used by both `pipeline.ts` and `rollback.ts` to avoid code duplication
 * (engineering rule 7: domain utilities get their own files).
 */

/**
 * Map a generated file path to its `OverrideMap` key.
 *
 * Matches by substring so the mapping is insensitive to directory prefixes:
 * - `'Dockerfile'` → `'dockerfile'`
 * - `'docker-compose'` → `'dockerCompose'`
 * - `'.github'` → `'gha'`
 * - `'sst.config'` → `'sst'`
 * - `'Caddyfile'` → `'caddy'`
 * - `'nginx'` → `'nginx'`
 *
 * @param filePath - The relative or absolute file path to classify.
 * @returns The matching override key, or `null` if no override is applicable.
 */
export function mapFileToOverrideKey(filePath: string): string | null {
  if (filePath.includes('Dockerfile')) return 'dockerfile';
  if (filePath.includes('docker-compose')) return 'dockerCompose';
  if (filePath.includes('.github')) return 'gha';
  if (filePath.includes('sst.config')) return 'sst';
  if (filePath.includes('Caddyfile')) return 'caddy';
  if (filePath.includes('nginx')) return 'nginx';
  return null;
}

/**
 * Extract the service name encoded in a per-service Dockerfile path.
 *
 * Preset generators name per-service Dockerfiles as `Dockerfile.<serviceName>`
 * so the deploy/rollback pipeline can look up service-level `dockerfile` overrides.
 *
 * @param path - File path to inspect (e.g. `'Dockerfile.api'`).
 * @returns The extracted service name, or `null` if the path does not match
 *   the `Dockerfile.<name>` pattern.
 */
export function extractServiceNameFromDockerfile(path: string): string | null {
  const match = path.match(/Dockerfile\.(.+)$/);
  return match ? match[1] : null;
}
