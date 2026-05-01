/**
 * WS host-only middleware for incoming events.
 *
 * Rejects WS messages from non-host users on events that require
 * host privileges (e.g., game:lobby.start, game:lobby.update).
 *
 * See spec §2.4.6 for the WS middleware pattern.
 */
import { GameErrorCode } from '../errors';

/** Dependencies for the WS host-only guard. */
export interface WsHostOnlyDeps {
  /**
   * Check if a user is the host of a session.
   *
   * @param sessionId - The session to check.
   * @param userId - The user to verify.
   * @returns `true` if the user is the host.
   */
  isHost(sessionId: string, userId: string): Promise<boolean>;
}

/**
 * Build a WS-level host-only guard.
 *
 * Returns a function that validates the sender is the session host
 * before allowing the message to proceed.
 *
 * @param deps - Closure-captured dependencies.
 * @returns A guard function that returns `true` if authorized, or sends
 *          an error and returns `false` if not.
 */
export function buildWsHostOnlyGuard(
  deps: WsHostOnlyDeps,
): (sessionId: string, userId: string, ack: (data: unknown) => void) => Promise<boolean> {
  return async (sessionId, userId, ack) => {
    let hostCheck: boolean;
    try {
      hostCheck = await deps.isHost(sessionId, userId);
    } catch (err) {
      ack({
        type: 'game:error',
        sessionId,
        code: GameErrorCode.INTERNAL_ERROR,
        message: 'Failed to verify host status.',
      });
      return false;
    }

    if (!hostCheck) {
      ack({
        type: 'game:error',
        sessionId,
        code: GameErrorCode.HOST_ONLY,
        message: 'Only the host can perform this action.',
      });
      return false;
    }

    return true;
  };
}
