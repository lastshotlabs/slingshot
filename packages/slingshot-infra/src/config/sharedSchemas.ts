import { z } from 'zod';

/**
 * Zod schema for the scaling configuration block shared across all preset
 * contexts (ECS task definitions, EC2 Auto Scaling groups, etc.).
 *
 * All fields are optional — omitting them leaves the decision to the
 * preset or cloud provider defaults.
 *
 * Fields:
 * - `min` — Minimum number of running instances (non-negative integer).
 *   Preset default is typically `1`.
 * - `max` — Maximum number of running instances (positive integer). Must be
 *   `>= min` when both are specified; the preset is responsible for enforcing
 *   this at deploy time.
 * - `cpu` — CPU allocation. Accepts either a numeric value (millicores for
 *   ECS, e.g. `256`) or a string (e.g. `'0.25 vCPU'` for Fargate). The
 *   interpretation is preset-specific.
 * - `memory` — Memory allocation in MiB (positive number). Preset-specific
 *   interpretation — ECS uses this as the hard limit.
 * - `targetCpuPercent` — Target CPU utilisation percentage for autoscaling
 *   policies (1–100). When set, the preset generates a CPU-based autoscaling
 *   policy targeting this value.
 *
 * @example
 * ```ts
 * import { scalingSchema } from '@lastshotlabs/slingshot-infra';
 *
 * scalingSchema.parse({ min: 1, max: 4, cpu: 256, memory: 512, targetCpuPercent: 70 });
 * ```
 */
export const scalingSchema = z.object({
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().positive().optional(),
  cpu: z.union([z.number(), z.string()]).optional(),
  memory: z.number().positive().optional(),
  targetCpuPercent: z.number().min(1).max(100).optional(),
});
