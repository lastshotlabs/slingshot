/**
 * Game engine error codes and error class.
 *
 * Every error the engine produces — REST and WS — uses a code from
 * this registry. Codes are string constants that clients can switch
 * on for i18n or UI logic. See spec §28.4 for the full registry.
 */

// ── Error Code Registry ───────────────────────────────────────────

/** All game engine error codes. */
export const GameErrorCode = {
  // Session errors
  GAME_TYPE_NOT_FOUND: 'GAME_TYPE_NOT_FOUND',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_FULL: 'SESSION_FULL',
  SESSION_SPECTATORS_FULL: 'SESSION_SPECTATORS_FULL',
  SESSION_NOT_IN_LOBBY: 'SESSION_NOT_IN_LOBBY',
  SESSION_NOT_PLAYING: 'SESSION_NOT_PLAYING',
  SESSION_WRONG_INSTANCE: 'SESSION_WRONG_INSTANCE',
  SESSION_ALREADY_STARTED: 'SESSION_ALREADY_STARTED',
  SESSION_COMPLETED: 'SESSION_COMPLETED',
  SESSION_NOT_COMPLETED: 'SESSION_NOT_COMPLETED',
  SESSION_ABANDONED: 'SESSION_ABANDONED',
  SESSION_START_FAILED: 'SESSION_START_FAILED',
  INSUFFICIENT_PLAYERS: 'INSUFFICIENT_PLAYERS',
  TOO_MANY_PLAYERS: 'TOO_MANY_PLAYERS',

  // Player errors
  PLAYER_NOT_IN_SESSION: 'PLAYER_NOT_IN_SESSION',
  PLAYER_ALREADY_IN_SESSION: 'PLAYER_ALREADY_IN_SESSION',
  PLAYER_IS_SPECTATOR: 'PLAYER_IS_SPECTATOR',
  PLAYER_KICKED: 'PLAYER_KICKED',
  PLAYER_DISCONNECTED: 'PLAYER_DISCONNECTED',
  HOST_ONLY: 'HOST_ONLY',
  PLAYER_BANNED: 'PLAYER_BANNED',

  // Input errors
  CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
  CHANNEL_NOT_OPEN: 'CHANNEL_NOT_OPEN',
  INPUT_VALIDATION_FAILED: 'INPUT_VALIDATION_FAILED',
  INPUT_UNAUTHORIZED: 'INPUT_UNAUTHORIZED',
  INPUT_NOT_YOUR_TURN: 'INPUT_NOT_YOUR_TURN',
  INPUT_ALREADY_SUBMITTED: 'INPUT_ALREADY_SUBMITTED',
  INPUT_RACE_ALREADY_CLAIMED: 'INPUT_RACE_ALREADY_CLAIMED',
  INPUT_RATE_LIMITED: 'INPUT_RATE_LIMITED',
  INPUT_REJECTED_BY_HANDLER: 'INPUT_REJECTED_BY_HANDLER',
  INPUT_DUPLICATE_SEQUENCE: 'INPUT_DUPLICATE_SEQUENCE',
  INPUT_INTERNAL_ERROR: 'INPUT_INTERNAL_ERROR',

  // Rules & content errors
  RULES_VALIDATION_FAILED: 'RULES_VALIDATION_FAILED',
  PRESET_NOT_FOUND: 'PRESET_NOT_FOUND',
  CONTENT_PROVIDER_NOT_FOUND: 'CONTENT_PROVIDER_NOT_FOUND',
  CONTENT_VALIDATION_FAILED: 'CONTENT_VALIDATION_FAILED',
  CONTENT_LOAD_FAILED: 'CONTENT_LOAD_FAILED',
  CONTENT_INSUFFICIENT: 'CONTENT_INSUFFICIENT',

  // Auth & tenant errors
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  TENANT_MISMATCH: 'TENANT_MISMATCH',

  // Infrastructure errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  STATE_CORRUPTION: 'STATE_CORRUPTION',
  SESSION_MUTEX_TIMEOUT: 'SESSION_MUTEX_TIMEOUT',
  CHECKPOINT_FAILED: 'CHECKPOINT_FAILED',
  REPLAY_APPEND_FAILED: 'REPLAY_APPEND_FAILED',
} as const;

/** Union type of all game engine error code values. */
export type GameErrorCodeValue = (typeof GameErrorCode)[keyof typeof GameErrorCode];

// ── Error Class ───────────────────────────────────────────────────

/**
 * Structured game engine error.
 *
 * Carries a machine-readable `code` from `GameErrorCode`, an HTTP status
 * (for REST responses), and optional structured `details` (e.g., Zod
 * validation errors, handler rejection reasons).
 */
export class GameError extends Error {
  /** Machine-readable error code from the registry. */
  readonly code: GameErrorCodeValue;

  /** HTTP status code for REST responses. */
  readonly httpStatus: number;

  /** Session ID, if the error relates to a specific session. */
  readonly sessionId?: string;

  /** Structured details (Zod errors, handler reasons, etc.). */
  readonly details?: unknown;

  constructor(
    code: GameErrorCodeValue,
    message: string,
    options?: {
      httpStatus?: number;
      sessionId?: string;
      details?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'GameError';
    this.code = code;
    this.httpStatus = options?.httpStatus ?? 500;
    this.sessionId = options?.sessionId;
    this.details = options?.details;
  }

  /** Serialize to the REST error response format. */
  toJSON(): {
    error: {
      code: string;
      message: string;
      details?: unknown;
      sessionId?: string;
    };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined && { details: this.details }),
        ...(this.sessionId !== undefined && { sessionId: this.sessionId }),
      },
    };
  }

  /** Serialize to the WS error message format. */
  toWsMessage(): {
    type: 'game:error';
    sessionId: string;
    code: string;
    message: string;
    details?: unknown;
  } {
    return {
      type: 'game:error',
      sessionId: this.sessionId ?? '',
      code: this.code,
      message: this.message,
      ...(this.details !== undefined && { details: this.details }),
    };
  }
}
