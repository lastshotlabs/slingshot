export interface VersioningConfig {
  /**
   * Version identifiers in ascending order, e.g. `["v1", "v2"]`.
   * Each version needs a matching subdirectory under `routesDir` (e.g. `routes/v1/`).
   */
  versions: string[];
  /**
   * Subdirectory name for routes shared across all versions. Shared route schemas
   * receive unprefixed names since they are version-agnostic. Default: `"shared"`.
   * Set `false` to disable shared route discovery.
   */
  sharedDir?: string | false;
  /**
   * Which version `/docs` and `/openapi.json` redirect to.
   * Defaults to the last version in the array (i.e. the latest).
   */
  defaultVersion?: string;
}
