/**
 * Rules system.
 *
 * Zod schema resolution, preset merging, conditional config, and freeze.
 * Rules are resolved at session creation and frozen for the session lifetime.
 *
 * See spec §17 for the full contract.
 */
import type { z } from 'zod';
import { GameError, GameErrorCode } from '../errors';
import type { GameDefinition } from '../types/models';

/**
 * Resolve rules for a session from preset + overrides.
 *
 * Flow:
 * 1. Start with empty object.
 * 2. If preset specified, merge preset values.
 * 3. Merge explicit overrides on top.
 * 4. Validate against the game definition's rules schema.
 * 5. Apply Zod defaults for unspecified fields.
 * 6. Freeze the result.
 *
 * @returns Frozen, validated rules object.
 * @throws GameError with RULES_VALIDATION_FAILED or PRESET_NOT_FOUND.
 */
export function resolveRules(
  gameDef: GameDefinition,
  preset?: string,
  overrides?: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  let rules: Record<string, unknown> = {};

  // Apply preset if specified
  if (preset) {
    const presetData = gameDef.presets[preset];
    rules = { ...presetData };
  }

  // Apply overrides
  if (overrides) {
    rules = { ...rules, ...overrides };
  }

  // Validate against game schema
  const result = gameDef.rules.safeParse(rules);
  if (!result.success) {
    throw new GameError(GameErrorCode.RULES_VALIDATION_FAILED, 'Rules validation failed.', {
      httpStatus: 400,
      details: result.error,
    });
  }

  // Freeze and return
  return Object.freeze(result.data as Record<string, unknown>);
}

/**
 * Merge partial rules update into existing rules.
 *
 * Used for `PATCH /game/sessions/:id/rules` in lobby.
 *
 * @returns Frozen, validated merged rules.
 */
export function mergeRules(
  gameDef: GameDefinition,
  currentRules: Readonly<Record<string, unknown>>,
  update: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const merged = { ...currentRules, ...update };

  const result = gameDef.rules.safeParse(merged);
  if (!result.success) {
    throw new GameError(GameErrorCode.RULES_VALIDATION_FAILED, 'Rules validation failed.', {
      httpStatus: 400,
      details: result.error,
    });
  }

  return Object.freeze(result.data as Record<string, unknown>);
}

/**
 * Extract the Zod schema's default values.
 * Useful for displaying rule defaults in the lobby UI.
 */
export function extractRulesDefaults(schema: z.ZodType): Record<string, unknown> {
  const result = schema.safeParse({});
  if (result.success) {
    return result.data as Record<string, unknown>;
  }
  return {};
}
