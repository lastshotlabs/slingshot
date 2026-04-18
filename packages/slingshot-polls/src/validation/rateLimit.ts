/**
 * Zod validation schema for `PollsRateLimitConfig`.
 *
 * @internal
 */
import { z } from 'zod';

const RateLimitBucketSchema = z.object({
  /** Sliding window — `"10s"`, `"1m"`, `"1h"`. */
  window: z.string().regex(/^\d+[smh]$/, 'Must be a duration like "10s", "1m", or "1h"'),
  /** Max requests allowed in the window. */
  max: z.number().int().positive(),
});

const RateLimitRuleSchema = z.object({
  perUser: RateLimitBucketSchema.optional(),
  perTenant: RateLimitBucketSchema.optional(),
});

/**
 * Zod schema for the `rateLimit` block in `PollsPluginConfig`.
 *
 * All keys are optional — absent config means no limiting for that operation.
 */
export const PollsRateLimitConfigSchema = z
  .object({
    vote: RateLimitRuleSchema.optional(),
    pollCreate: RateLimitRuleSchema.optional(),
    results: RateLimitRuleSchema.optional(),
  })
  .optional();
