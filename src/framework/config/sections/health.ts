import { z } from 'zod';

/**
 * Zod schema for the `health` section of `CreateAppConfig`.
 *
 * Controls user-defined readiness probes registered via `defineHealthIndicator`.
 * Each indicator runs on every `/health/ready` request, and its failure severity
 * controls whether the response flips to 503.
 *
 * Each indicator is stored opaquely (passthrough) — the runtime check function,
 * name, and severity are read by the framework's readiness route, not validated
 * shape-by-shape here.
 */
export const healthIndicatorSchema = z
  .object({
    name: z.string().min(1),
    severity: z.enum(['critical', 'warning']).optional(),
    check: z.function(),
  })
  .passthrough();

export const healthSchema = z
  .object({
    indicators: z.array(healthIndicatorSchema).optional(),
  })
  .passthrough();
