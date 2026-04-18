/**
 * Zod schemas for session creation and update validation.
 *
 * These schemas validate REST request bodies for session endpoints.
 * See spec §26.2 for the full REST API surface.
 *
 * @internal
 */
import { z } from 'zod';

/** Schema for `POST /game/sessions` request body. */
export const SessionCreateInputSchema = z.object({
  gameType: z
    .string()
    .min(1)
    .max(100)
    .describe('Game type name (references a registered GameDefinition).'),
  rules: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Rule overrides. Merged on top of preset values (if any) and validated against the game definition rules schema.',
    ),
  preset: z.string().optional().describe('Named preset to apply before rule overrides.'),
  content: z
    .object({
      provider: z.string().min(1).describe('Content provider name.'),
      input: z.unknown().optional().describe('Provider-specific input.'),
      data: z.unknown().optional().describe('Raw content data (for custom provider).'),
    })
    .optional()
    .describe('Content source configuration.'),
});

/** Schema for `POST /game/sessions/join/:code` request body. */
export const SessionJoinByCodeInputSchema = z.object({
  code: z
    .string()
    .min(4)
    .max(6)
    .regex(/^[A-Z2-9]+$/)
    .describe('Short join code (4-6 uppercase alphanumeric).'),
  team: z.string().optional().describe("Team selection (for 'self-select' team assignment)."),
});

/** Schema for `POST /game/sessions/:id/join` request body. */
export const SessionJoinByIdInputSchema = z.object({
  team: z.string().optional().describe("Team selection (for 'self-select' team assignment)."),
});

/** Schema for `PATCH /game/sessions/:id/rules` request body. */
export const SessionUpdateRulesInputSchema = z.object({
  rules: z
    .record(z.string(), z.unknown())
    .describe('Partial rules update, merged with current rules.'),
});

/** Schema for `PATCH /game/sessions/:id/content` request body. */
export const SessionUpdateContentInputSchema = z.object({
  provider: z.string().min(1).describe('Content provider name.'),
  input: z.unknown().optional().describe('Provider-specific input (e.g., playlist URL, deck ID).'),
});

/** Schema for `PATCH /game/sessions/:id/preset` request body. */
export const SessionApplyPresetInputSchema = z.object({
  preset: z.string().min(1).describe('Named preset to apply.'),
});

/** Schema for `POST /game/sessions/:id/end` request body. */
export const SessionEndInputSchema = z.object({
  reason: z.string().max(500).optional().describe('Reason for ending the game early.'),
});

export type SessionCreateInput = z.output<typeof SessionCreateInputSchema>;
export type SessionJoinByCodeInput = z.output<typeof SessionJoinByCodeInputSchema>;
export type SessionUpdateRulesInput = z.output<typeof SessionUpdateRulesInputSchema>;
