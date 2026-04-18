import { z } from 'zod';

/**
 * Zod schema for the `versioning` section when supplied as a plain object in
 * `CreateAppConfig` / `CreateServerConfig`.
 *
 * Enables API versioning support. When configured, the framework mounts each
 * API version under its own path prefix (e.g. `/v1`, `/v2`) and resolves
 * shared utility modules from a common directory.
 *
 * `versioning` can also be supplied as a shorthand array of version strings
 * (e.g. `["v1", "v2"]`), which is equivalent to `{ versions: ["v1", "v2"] }`.
 *
 * @remarks
 * **Fields:**
 * - `versions` — **Required** in object form. Ordered array of version
 *   identifier strings (e.g. `["v1", "v2"]`). Each version causes the
 *   framework to load routes from `{routesDir}/{version}/` and mount them
 *   under `/{version}/`. The array order is significant: the last entry is
 *   treated as the latest version for documentation and redirect purposes.
 * - `sharedDir` — Path (relative to `routesDir`) of a directory containing
 *   modules shared across all versions (e.g. common middleware, helpers).
 *   Defaults to `"shared"` when omitted. Set to an empty string `""` to
 *   disable shared-module loading.
 * - `defaultVersion` — The version string used when a request omits the version
 *   prefix entirely (e.g. a plain `/users` request). Must be one of the strings
 *   in `versions`. When omitted, un-prefixed requests are not rewritten and
 *   will only match routes that explicitly omit a version prefix.
 *
 * **Normalisation performed at runtime (not by the schema):**
 * - The shorthand array form is converted to `{ versions: [...] }` before
 *   further processing.
 * - `defaultVersion` is validated against `versions` at startup; a mismatch
 *   throws with a descriptive error message.
 *
 * @example
 * ```ts
 * // Object form in CreateServerConfig:
 * versioning: {
 *   versions: ['v1', 'v2'],
 *   sharedDir: 'common',
 *   defaultVersion: 'v2',
 * }
 *
 * // Shorthand array form:
 * versioning: ['v1', 'v2'],
 * ```
 */
export const versioningObjectSchema = z.object({
  versions: z.array(z.string()),
  sharedDir: z.string().optional(),
  defaultVersion: z.string().optional(),
});
