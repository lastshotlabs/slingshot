import { z } from 'zod';
import { fnSchema } from './shared';

/**
 * Zod schema for the `logging` section of `CreateAppConfig` / `CreateServerConfig`.
 *
 * Controls the built-in HTTP request logger and log-level filtering. The logger
 * records method, path, status code, and response time for every inbound
 * request that is not excluded.
 *
 * @remarks
 * **Fields:**
 * - `enabled` — Master switch. When `false`, the request logger middleware is
 *   not mounted. Defaults to `true`.
 * - `verbose` — Enables non-request diagnostic console logs from framework and
 *   plugin helpers. Defaults to `false` when `enabled` is `false`; otherwise it
 *   follows `LOGGING_VERBOSE` / non-production mode.
 * - `authTrace` — Enables auth trace lines that may include user or session IDs.
 *   Defaults to `false` unless verbose logging is enabled and
 *   `LOGGING_AUTH_TRACE=true`.
 * - `auditWarnings` — Enables non-fatal audit-log provider warnings such as the
 *   in-memory adapter caveat. Defaults to the resolved `verbose` value.
 * - `onLog` — Custom log-sink callback invoked for each request instead of (or
 *   in addition to) the default console output. Signature:
 *   `(entry: LogEntry) => void`. When provided, the default console logger is
 *   bypassed.
 * - `level` — Minimum severity level to emit. One of `"debug"`, `"info"`,
 *   `"warn"`, or `"error"`. Log calls below this level are silently dropped.
 *   Defaults to `"info"`.
 * - `excludePaths` — Array of path strings or `RegExp` instances. Requests
 *   whose URL pathname matches any entry are skipped entirely by the logger.
 *   Useful for suppressing health-check or metrics-scrape noise.
 * - `excludeMethods` — Array of HTTP method strings (uppercase, e.g.
 *   `["OPTIONS", "HEAD"]`). Requests using any of these methods are not logged.
 *
 * **Defaults applied at runtime (not by the schema):**
 * - `enabled` → `true`
 * - `level` → `"info"`
 *
 * @example
 * ```ts
 * // In CreateServerConfig:
 * logging: {
 *   enabled: true,
 *   level: 'warn',
 *   excludePaths: ['/health', /^\/metrics/],
 *   excludeMethods: ['OPTIONS'],
 * }
 * ```
 */
export const loggingSchema = z.object({
  enabled: z.boolean().optional(),
  verbose: z.boolean().optional(),
  authTrace: z.boolean().optional(),
  auditWarnings: z.boolean().optional(),
  onLog: fnSchema.optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  excludePaths: z.array(z.union([z.string(), z.instanceof(RegExp)])).optional(),
  excludeMethods: z.array(z.string()).optional(),
});
