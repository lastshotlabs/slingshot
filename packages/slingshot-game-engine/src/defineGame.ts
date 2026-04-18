/**
 * `defineGame()` DSL for game developers.
 *
 * Accepts a `GameDefinitionInput` with partial/optional fields, applies
 * defaults, validates structure, and returns a frozen `GameDefinition`.
 *
 * This is the primary API for game developers to define game types.
 *
 * See spec §4 for the full contract.
 */
import type { z } from 'zod';
import type { GameDefinition, GameDefinitionInput, SyncDefinition } from './types/models';

/**
 * Define a game type.
 *
 * Takes a `GameDefinitionInput` with optional fields, resolves defaults,
 * and returns a frozen `GameDefinition` ready for registration.
 *
 * @example
 * ```ts
 * import { defineGame } from 'slingshot-game-engine';
 * import { z } from 'zod';
 *
 * const trivia = defineGame({
 *   name: 'trivia',
 *   display: 'Trivia Night',
 *   minPlayers: 2,
 *   maxPlayers: 8,
 *   rules: z.object({
 *     rounds: z.number().default(10),
 *     timePerQuestion: z.number().default(30000),
 *   }),
 *   phases: {
 *     question: { next: 'answer', channels: { ... } },
 *     answer: { next: 'question', ... },
 *   },
 *   handlers: { ... },
 * });
 * ```
 */
export function defineGame<
  TRules extends z.ZodType = z.ZodType,
  TGameState extends Record<string, unknown> = Record<string, unknown>,
  TContent extends z.ZodType | undefined = undefined,
>(input: GameDefinitionInput<TRules, TGameState, TContent>): GameDefinition {
  // Validate required fields
  if (!input.name || typeof input.name !== 'string') {
    throw new Error('defineGame: `name` is required and must be a non-empty string.');
  }
  if (!input.display || typeof input.display !== 'string') {
    throw new Error('defineGame: `display` is required and must be a non-empty string.');
  }
  if (typeof input.minPlayers !== 'number' || input.minPlayers < 1) {
    throw new Error('defineGame: `minPlayers` must be at least 1.');
  }
  if (typeof input.maxPlayers !== 'number' || input.maxPlayers < input.minPlayers) {
    throw new Error('defineGame: `maxPlayers` must be >= minPlayers.');
  }
  if (Object.keys(input.phases).length === 0) {
    throw new Error('defineGame: at least one phase is required.');
  }

  // Validate handler references in phases
  for (const [phaseName, phaseDef] of Object.entries(input.phases)) {
    if (phaseDef.onEnter && !(phaseDef.onEnter in input.handlers)) {
      throw new Error(
        `defineGame: phase '${phaseName}' references handler '${phaseDef.onEnter}' (onEnter) but it is not defined in handlers.`,
      );
    }
    if (phaseDef.onExit && !(phaseDef.onExit in input.handlers)) {
      throw new Error(
        `defineGame: phase '${phaseName}' references handler '${phaseDef.onExit}' (onExit) but it is not defined in handlers.`,
      );
    }
    if (phaseDef.channels) {
      for (const [channelName, channelDef] of Object.entries(phaseDef.channels)) {
        if (channelDef.process && !(channelDef.process in input.handlers)) {
          throw new Error(
            `defineGame: channel '${channelName}' in phase '${phaseName}' references handler '${channelDef.process}' (process) but it is not defined in handlers.`,
          );
        }
      }
    }
    // Validate sub-phase handler references
    if (phaseDef.subPhases) {
      for (const [subPhaseName, subPhaseDef] of Object.entries(phaseDef.subPhases)) {
        if (subPhaseDef.onEnter && !(subPhaseDef.onEnter in input.handlers)) {
          throw new Error(
            `defineGame: sub-phase '${subPhaseName}' in phase '${phaseName}' references handler '${subPhaseDef.onEnter}' (onEnter) but it is not defined in handlers.`,
          );
        }
        if (subPhaseDef.onExit && !(subPhaseDef.onExit in input.handlers)) {
          throw new Error(
            `defineGame: sub-phase '${subPhaseName}' in phase '${phaseName}' references handler '${subPhaseDef.onExit}' (onExit) but it is not defined in handlers.`,
          );
        }
      }
    }
  }

  // Validate game loop handler reference
  if (input.loop?.onTick && !(input.loop.onTick in input.handlers)) {
    throw new Error(
      `defineGame: game loop references handler '${input.loop.onTick}' (onTick) but it is not defined in handlers.`,
    );
  }

  // Resolve defaults
  const defaultSync: SyncDefinition = { mode: 'event' };

  const definition: GameDefinition = {
    name: input.name,
    display: input.display,
    description: input.description ?? '',
    version: input.version ?? '0.0.0',
    icon: input.icon ?? '',
    tags: Object.freeze(input.tags ?? []),
    minPlayers: input.minPlayers,
    maxPlayers: input.maxPlayers,
    allowSpectators: input.allowSpectators ?? true,
    maxSpectators: input.maxSpectators ?? 50,
    roles: Object.freeze(input.roles ?? {}),
    roleVisibility: Object.freeze(input.roleVisibility ?? {}),
    teams: input.teams ? Object.freeze(input.teams) : null,
    rules: input.rules,
    presets: Object.freeze(input.presets ?? {}),
    content: input.content ? Object.freeze(input.content as GameDefinition['content']) : null,
    playerStates: Object.freeze(input.playerStates ?? []),
    initialPlayerState: input.initialPlayerState ?? input.playerStates?.[0] ?? null,
    phases: Object.freeze(input.phases),
    loop: input.loop ? Object.freeze(input.loop) : null,
    sync: Object.freeze(input.sync ?? defaultSync),
    scoring: input.scoring ? Object.freeze(input.scoring) : null,
    handlers: Object.freeze(input.handlers),
    hooks: Object.freeze(input.hooks ?? {}),
    checkWinCondition: input.checkWinCondition ?? null,
    relayFilters: Object.freeze(input.relayFilters ?? {}),
    rngSeed: input.rngSeed ?? 'random',
    disconnect: input.disconnect ? Object.freeze(input.disconnect) : null,
  };

  return Object.freeze(definition);
}
