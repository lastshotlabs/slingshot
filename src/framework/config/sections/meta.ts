import { z } from 'zod';

/**
 * Zod schema for the `meta` section of `CreateAppConfig` / `CreateServerConfig`.
 *
 * Captures human-readable application identity information. All fields are
 * optional; omitting them has no functional effect on runtime behavior — the
 * values are surfaced in health-check responses and log output only.
 *
 * @remarks
 * **Fields:**
 * - `name` — Human-readable application name (e.g. `"My API"`). Appears in
 *   log prefixes and the `/health` response body.
 * - `version` — Semver-style application version string (e.g. `"1.2.3"`).
 *   Surfaced in the `/health` response body alongside `name`.
 *
 * No normalization or defaulting is performed on these fields; values are
 * passed through verbatim.
 *
 * @example
 * ```ts
 * // In CreateServerConfig:
 * meta: {
 *   name: 'Acme API',
 *   version: '2.0.0',
 * }
 * ```
 */
export const appSectionSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
});
