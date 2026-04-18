/**
 * Input pipeline.
 *
 * 14-step input processing flow: validate → authorize → rate limit →
 * channel check → process → route → ack. All steps run within the
 * session mutex.
 *
 * See spec §12 for the full contract.
 */
import { GameErrorCode } from '../errors';
import type {
  ChannelDefinition,
  ChannelFromConfig,
  GamePlayerState,
  InputAck,
  ReadonlyHandlerContext,
} from '../types/models';

/**
 * Validate that a user is authorized to submit to a channel based
 * on the channel's `from` config.
 */
export function isAuthorizedForChannel(
  from: ChannelFromConfig,
  userId: string,
  player: GamePlayerState,
  activePlayerId: string | null,
  ctx: ReadonlyHandlerContext,
): boolean {
  if (typeof from === 'function') {
    return from(ctx, userId);
  }

  switch (from) {
    case 'all-players':
      return !player.isSpectator;
    case 'active-player':
      return userId === activePlayerId;
    case 'other-players':
      return userId !== activePlayerId && !player.isSpectator;
    case 'host':
      return player.isHost;
  }

  if (typeof from === 'object') {
    if ('role' in from && 'state' in from) {
      return player.role === from.role && player.playerState === from.state;
    }
    if ('role' in from && 'team' in from) {
      if (from.team === 'active') {
        // Active team check — requires game-specific resolution
        return player.role === from.role;
      }
      return player.role === from.role && player.team === from.team;
    }
    if ('role' in from) {
      return player.role === from.role;
    }
    if ('state' in from) {
      if (Array.isArray(from.state)) {
        return from.state.includes(player.playerState ?? '');
      }
      return player.playerState === from.state;
    }
    if ('team' in from) {
      if (from.team === 'active' || from.team === 'inactive') {
        // Active/inactive team requires game-specific resolution
        return !player.isSpectator;
      }
      return player.team === from.team;
    }
    if ('players' in from) {
      if (typeof from.players === 'string') {
        // State key — resolve from gameState
        const playerList = ctx.gameState[from.players];
        if (Array.isArray(playerList)) {
          return playerList.includes(userId);
        }
        return false;
      }
      return from.players.includes(userId);
    }
  }

  return false;
}

/**
 * Build a rejection InputAck.
 */
export function rejectInput(
  code: string,
  reason: string,
  sequence?: number,
  details?: unknown,
): InputAck {
  return {
    accepted: false,
    code,
    reason,
    sequence,
    details,
  };
}

/**
 * Build an acceptance InputAck.
 */
export function acceptInput(sequence?: number, data?: unknown): InputAck {
  return {
    accepted: true,
    sequence,
    data,
  };
}

/**
 * Validate input data against a channel's Zod schema.
 *
 * @returns Parsed data on success, or an InputAck rejection on failure.
 */
export function validateInput(
  channelDef: ChannelDefinition,
  data: unknown,
  sequence?: number,
): { valid: true; parsed: unknown } | { valid: false; ack: InputAck } {
  const result = channelDef.schema.safeParse(data);
  if (!result.success) {
    return {
      valid: false,
      ack: rejectInput(
        GameErrorCode.INPUT_VALIDATION_FAILED,
        'Input validation failed.',
        sequence,
        result.error,
      ),
    };
  }
  return { valid: true, parsed: result.data };
}
