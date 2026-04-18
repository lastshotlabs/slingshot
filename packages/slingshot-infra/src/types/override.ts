/**
 * Override spec for a single generated deployment file.
 *
 * - `string`: path to a file that replaces the generated one entirely.
 *   Absolute paths are used as-is; relative paths are resolved from app root.
 *
 * - `object`: deep-merged into the generated configuration.
 *   For structured formats (JSON, YAML), the object is parsed, merged, and
 *   re-serialized. For text formats (Dockerfile, NGINX/Caddy config), object
 *   keys map to named `# --- section:name ---` blocks in the generated template.
 *
 * @example
 * ```ts
 * // Replace the entire Dockerfile with a local file:
 * overrides: { dockerfile: './deploy/Dockerfile.prod' }
 *
 * // Deep-merge into docker-compose.yml:
 * overrides: { dockerCompose: { services: { api: { environment: { NODE_ENV: 'production' } } } } }
 * ```
 */
export type OverrideSpec = string | Record<string, unknown>;

/**
 * Map of per-file override specs for `DefineInfraConfig.overrides`.
 *
 * Each key corresponds to a specific generated file. Set a key to an
 * `OverrideSpec` to customize or replace that file's content at deploy time.
 */
export interface OverrideMap {
  /** Override for the generated `Dockerfile` (or `Dockerfile.<service>`). */
  dockerfile?: OverrideSpec;
  /** Override for the generated `docker-compose.yml`. */
  dockerCompose?: OverrideSpec;
  /** Override for the generated GitHub Actions workflow. */
  gha?: OverrideSpec;
  /** Override for the generated `sst.config.ts`. */
  sst?: OverrideSpec;
  /** Override for the generated `Caddyfile`. */
  caddy?: OverrideSpec;
  /** Override for the generated `nginx.conf`. */
  nginx?: OverrideSpec;
}
