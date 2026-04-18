/**
 * Zod validation schemas for poll creation and close operations.
 *
 * Schemas are parameterized via `buildPollSchemas()` so limits come from
 * plugin config, not hard-coded constants.
 *
 * @internal
 */
import { z } from 'zod';

/**
 * Build parameterized Zod schemas for poll inputs.
 *
 * Limits (`maxOptions`, `maxQuestionLength`, `maxOptionLength`) are read
 * from the plugin config at construction time (Rule 12 — freeze at the
 * boundary).
 */
export function buildPollSchemas(config: {
  maxOptions: number;
  maxQuestionLength: number;
  maxOptionLength: number;
}) {
  const option = z.string().trim().min(1).max(config.maxOptionLength);

  const PollCreateInputSchema = z.object({
    sourceType: z.string().min(1).max(64),
    sourceId: z.string().min(1).max(128),
    scopeId: z.string().min(1).max(128),
    question: z.string().trim().min(1).max(config.maxQuestionLength),
    options: z.array(option).min(2).max(config.maxOptions),
    multiSelect: z.boolean().optional().default(false),
    anonymous: z.boolean().optional().default(false),
    closesAt: z.iso.datetime().optional(),
  });

  const PollClosePollInputSchema = z.object({
    id: z.uuid(),
  });

  return { PollCreateInputSchema, PollClosePollInputSchema };
}

export type PollCreateInputSchema = ReturnType<typeof buildPollSchemas>['PollCreateInputSchema'];
