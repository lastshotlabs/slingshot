/**
 * Lobby-only guard middleware.
 *
 * Rejects requests if the session status is not `'lobby'`.
 * Used on operations that are only valid before the game starts
 * (e.g., `updateRules`, `updateContent`, `assignTeam`, `assignRole`).
 *
 * @internal
 */
import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { GameErrorCode } from '../errors';

interface LobbyOnlyGuardDeps {
  getSessionAdapter: () => { getById(id: string): Promise<Record<string, unknown> | null> };
}

/**
 * Build the lobby-only guard middleware.
 *
 * Registered under `'lobbyOnlyGuard'` in the named middleware map.
 */
export function buildLobbyOnlyGuard({ getSessionAdapter }: LobbyOnlyGuardDeps) {
  return async (c: Context, next: Next) => {
    const sessionId = c.req.param('id') ?? c.req.param('sessionId');

    if (!sessionId) {
      throw new HTTPException(400, { message: 'Missing session ID.' });
    }

    const adapter = getSessionAdapter();
    const session = await adapter.getById(sessionId);

    if (!session) {
      throw new HTTPException(404, { message: 'Session not found.' });
    }

    if (session.status !== 'lobby') {
      throw new HTTPException(409, {
        message: `This action is only available in lobby status. Code: ${GameErrorCode.SESSION_NOT_IN_LOBBY}`,
      });
    }

    await next();
  };
}
