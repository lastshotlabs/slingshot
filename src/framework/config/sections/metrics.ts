import { z } from 'zod';
import { fnSchema } from './shared';

/**
 * Zod schema for the `metrics` section of `CreateAppConfig` / `CreateServerConfig`.
 *
 * Controls the Prometheus-compatible metrics endpoint and the collection of
 * HTTP and job-queue metrics. When this section is provided, the framework
 * mounts a `/metrics` endpoint that returns a Prometheus text-format scrape.
 *
 * @remarks
 * **Fields:**
 * - `enabled` — Master switch for metrics collection and endpoint mounting.
 *   Defaults to `true` when the section is present. Set to `false` to include
 *   the section for future use without activating anything.
 * - `auth` — Access-control strategy for the `/metrics` endpoint:
 *   - `"userAuth"` — Require an authenticated session (not recommended for
 *     machine scraping; prefer a reverse-proxy allowlist instead).
 *   - `"none"` — No authentication (default). Suitable when the endpoint is
 *     protected at the network level.
 *   - `Array` — Custom Hono middleware chain applied before the handler.
 * - `excludePaths` — Array of URL path strings whose requests are excluded from
 *   HTTP metrics histograms. Useful for noisy health-check or internal paths.
 * - `normalizePath` — Function `(path: string) => string` applied to each
 *   request path before it is used as a histogram label. Use this to collapse
 *   dynamic segments (e.g. `/users/123` → `/users/:id`) and avoid unbounded
 *   label cardinality.
 * - `queues` — Array of job-queue names for which job-duration and throughput
 *   metrics are collected. Omit to skip queue metrics entirely.
 * - `unsafePublic` — When `true`, the `/metrics` endpoint is publicly
 *   accessible with no auth check. Equivalent to `auth: "none"` but explicit.
 *   **Do not use in production** without a network-level guard.
 *
 * **Mutual exclusions:**
 * - `unsafePublic: true` and `auth: "userAuth"` conflict; `unsafePublic` wins.
 *
 * @example
 * ```ts
 * // In CreateServerConfig:
 * metrics: {
 *   enabled: true,
 *   auth: 'none',
 *   excludePaths: ['/health'],
 *   normalizePath: (p) => p.replace(/\/\d+/g, '/:id'),
 *   queues: ['email', 'exports'],
 * }
 * ```
 */
export const metricsSchema = z.object({
  enabled: z.boolean().optional(),
  auth: z.union([z.enum(['userAuth', 'none']), z.array(z.unknown())]).optional(),
  excludePaths: z.array(z.string()).optional(),
  normalizePath: fnSchema.optional(),
  queues: z.array(z.string()).optional(),
  unsafePublic: z.boolean().optional(),
});
